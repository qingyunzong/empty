import { DecimateConfig, FirConfig, Sample } from './sample';

export function validateFirTaps(taps: readonly number[]): void {
  if (taps.length === 0) throw new Error('fir: taps must be non-empty');
  if (taps.length % 2 === 0) {
    throw new Error('fir: taps must have odd length so the group delay is an integer number of samples');
  }
  for (let k = 0; k < taps.length; k++) {
    const t = taps[k]!;
    if (!Number.isInteger(t)) throw new Error(`fir: tap ${k} is not an integer (${t})`);
    if (t !== taps[taps.length - 1 - k]) {
      throw new Error(`fir: taps must be symmetric (tap ${k} !== tap ${taps.length - 1 - k})`);
    }
  }
}

export function validateDecimate(factor: number, phase: number): void {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`decimate: factor must be an integer >= 1 (got ${factor})`);
  }
  if (!Number.isInteger(phase) || phase < 0 || phase >= factor) {
    throw new Error(`decimate: phase must be an integer in [0, ${factor - 1}] (got ${phase})`);
  }
}

/** A stage that has not (yet) received any input produces no tail. */
const ZERO: Sample = { value: 0, first: Number.POSITIVE_INFINITY, last: Number.NEGATIVE_INFINITY, center: 0 };

export interface Stage {
  push(s: Sample, out: Sample[]): void;
  flush(out: Sample[]): void;
}

/**
 * Streaming integer FIR. State (the M-sample window) persists across push()
 * calls, so block boundaries never reset anything. An output is emitted only
 * once the window is full ("valid" convolution); the remaining M-1 outputs
 * form the tail handled by flush().
 */
export class FirStage implements Stage {
  readonly taps: readonly number[];
  /** Integer group delay (taps.length - 1) / 2, in local samples. */
  readonly delay: number;
  private window: Sample[] = []; // oldest first, length <= taps.length
  private lastCenter: number | null = null;
  private lastStep = 1;

  constructor(config: FirConfig) {
    validateFirTaps(config.taps);
    this.taps = config.taps.slice();
    this.delay = (this.taps.length - 1) / 2;
  }

  push(s: Sample, out: Sample[]): void {
    if (this.lastCenter !== null) this.lastStep = s.center - this.lastCenter;
    this.lastCenter = s.center;
    this.window.push(s);
    if (this.window.length > this.taps.length) this.window.shift();
    if (this.window.length === this.taps.length) this.emit(out);
  }

  flush(out: Sample[]): void {
    if (this.window.length === 0) return;
    const base = this.lastCenter!;
    for (let i = 1; i <= this.taps.length - 1; i++) {
      // Zero padding contributes nothing to first/last (sentinels) and its
      // center is extrapolated with the last observed step.
      this.push({ ...ZERO, center: base + i * this.lastStep }, out);
    }
  }

  private emit(out: Sample[]): void {
    const m = this.taps.length;
    let acc = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < m; k++) {
      const s = this.window[m - 1 - k]!;
      acc += this.taps[k]! * s.value;
      if (s.first < first) first = s.first;
      if (s.last > last) last = s.last;
    }
    out.push({ value: acc, first, last, center: this.window[m - 1 - this.delay]!.center });
  }
}

/**
 * Streaming decimator. Emits input s when (seen % factor) === phase.
 * The counter persists across push() calls. flush() emits nothing: an
 * incomplete decimation period is always dropped.
 */
export class DecimateStage implements Stage {
  readonly factor: number;
  readonly phase: number;
  private seen = 0;

  constructor(config: DecimateConfig) {
    const phase = config.phase ?? 0;
    validateDecimate(config.factor, phase);
    this.factor = config.factor;
    this.phase = phase;
  }

  push(s: Sample, out: Sample[]): void {
    if (this.seen % this.factor === this.phase) out.push(s);
    this.seen++;
  }

  flush(_out: Sample[]): void {
    // No tail: incomplete decimation periods are dropped.
  }
}
