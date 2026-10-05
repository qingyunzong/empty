import type { Sample, TailPolicy } from './types.js';
import { assertInteger } from './types.js';

export interface FirConfig {
  /** Integer tap coefficients, oldest tap first. */
  readonly coeffs: readonly number[];
  /**
   * Group delay in local (stage-rate) samples, used to stamp output times.
   * Defaults to `(coeffs.length - 1) / 2`, the exact group delay of
   * (anti-)symmetric linear-phase filters. Must lie in `[0, coeffs.length - 1]`.
   */
  readonly delay?: number;
}

export interface FirSwitch {
  /**
   * Original-time sample number at which the new configuration takes effect.
   * The switch is applied to the first input sample of this stage whose
   * `time` is `>= at`; earlier samples are entirely unaffected.
   */
  readonly at: number;
  readonly config: FirConfig;
  /** How the old delay line is treated at the switch. Default: `'keep'`. */
  readonly tail?: TailPolicy;
}

/**
 * Streaming integer FIR filter. State lives entirely inside the instance;
 * `processBlock` may be called with arbitrarily sized blocks and never
 * resets state at block boundaries.
 *
 * Integer exactness: inputs and coefficients must be integers. The result
 * is exact as long as every partial sum stays within `Number.MAX_SAFE_INTEGER`.
 */
export class Fir {
  private coeffs: number[];
  private delay: number;
  private hist: Sample[] = [];
  private prevTime: number | null = null;
  private switches: FirSwitch[] = [];

  constructor(config: FirConfig) {
    const normalized = Fir.normalize(config);
    this.coeffs = normalized.coeffs;
    this.delay = normalized.delay;
  }

  private static normalize(config: FirConfig): { coeffs: number[]; delay: number } {
    if (config.coeffs.length === 0) {
      throw new RangeError('FIR needs at least one tap');
    }
    for (const c of config.coeffs) assertInteger('coefficient', c);
    const delay = config.delay ?? (config.coeffs.length - 1) / 2;
    if (!(delay >= 0 && delay <= config.coeffs.length - 1)) {
      throw new RangeError(
        `delay must lie in [0, ${config.coeffs.length - 1}], got ${delay}`,
      );
    }
    return { coeffs: [...config.coeffs], delay };
  }

  /** Group delay in local (stage-rate) samples, for the current config. */
  get groupDelay(): number {
    return this.delay;
  }

  /** Number of taps of the current config. */
  get numTaps(): number {
    return this.coeffs.length;
  }

  /**
   * Schedule a configuration switch at an explicit original-time sample
   * number. Switches may be registered in any order; they are applied in
   * sample-number order (registration order for ties). A switch registered
   * after its sample number has already passed takes effect on the next
   * processed sample.
   */
  scheduleSwitch(sw: FirSwitch): void {
    assertInteger('switch sample number', sw.at);
    Fir.normalize(sw.config);
    let i = this.switches.length;
    while (i > 0 && this.switches[i - 1].at > sw.at) i--;
    this.switches.splice(i, 0, sw);
  }

  processBlock(input: readonly Sample[]): Sample[] {
    const out: Sample[] = [];
    for (const s of input) out.push(this.processOne(s));
    return out;
  }

  private processOne(s: Sample): Sample {
    while (this.switches.length > 0 && s.time >= this.switches[0].at) {
      const sw = this.switches.shift()!;
      const normalized = Fir.normalize(sw.config);
      this.coeffs = normalized.coeffs;
      this.delay = normalized.delay;
      const tail = sw.tail ?? 'keep';
      if (tail === 'zero') {
        this.hist = [];
      } else if (this.hist.length > this.coeffs.length - 1) {
        this.hist = this.hist.slice(this.hist.length - (this.coeffs.length - 1));
      }
    }

    const n = this.coeffs.length;
    const win = this.hist.concat([s]); // oldest first, newest last
    this.hist = win.slice(Math.max(0, win.length - (n - 1)));

    const spacing = this.prevTime === null ? 1 : s.time - this.prevTime;
    this.prevTime = s.time;

    // win is shorter than n only during stream warm-up or after a 'zero'
    // switch; the missing leading samples are zero and contribute nothing.
    const off = n - win.length;
    let acc = 0;
    for (let i = 0; i < win.length; i++) acc += this.coeffs[off + i] * win[i].value;

    const newest = win.length - 1;
    const lag = this.delay;
    let time: number;
    if (lag <= newest) {
      // Center lies inside the known window: interpolate real sample times.
      const pos = newest - lag;
      const p0 = Math.floor(pos);
      const p1 = Math.ceil(pos);
      const f = pos - p0;
      time = win[p0].time * (1 - f) + win[p1].time * f;
    } else {
      // Center lies before the oldest known sample (warm-up / freshly
      // cleared tail): extrapolate backwards with the last seen spacing.
      time = win[0].time - (lag - newest) * spacing;
    }

    return { value: acc, time, srcFirst: win[0].srcFirst, srcLast: s.srcLast };
  }
}
