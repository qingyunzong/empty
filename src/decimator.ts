import type { Sample } from './types.js';
import { assertInteger } from './types.js';

export interface DecimatorConfig {
  /** Keep one sample out of every `factor`. Must be an integer >= 1. */
  readonly factor: number;
  /**
   * Which local input positions are kept: a sample is kept when
   * `count % factor === phase`, where `count` is the number of samples this
   * stage has consumed so far. Default 0. Must satisfy `0 <= phase < factor`.
   */
  readonly phase?: number;
}

export interface DecimatorSwitch {
  /**
   * Original-time sample number at which the new configuration takes effect
   * (first stage input with `time >= at`). The local sample counter is NOT
   * reset: the new factor/phase applies to the continuously running count.
   */
  readonly at: number;
  readonly config: DecimatorConfig;
}

/**
 * Integer decimator. Passes sample annotations (time, source range) through
 * unchanged; its own group delay is 0. State (the sample counter) persists
 * across blocks and across configuration switches.
 */
export class Decimator {
  private currentFactor: number;
  private currentPhase: number;
  private count = 0;
  private switches: DecimatorSwitch[] = [];

  constructor(config: DecimatorConfig) {
    const normalized = Decimator.normalize(config);
    this.currentFactor = normalized.factor;
    this.currentPhase = normalized.phase;
  }

  private static normalize(config: DecimatorConfig): { factor: number; phase: number } {
    assertInteger('decimation factor', config.factor);
    if (config.factor < 1) {
      throw new RangeError(`decimation factor must be >= 1, got ${config.factor}`);
    }
    const phase = config.phase ?? 0;
    assertInteger('decimation phase', phase);
    if (phase < 0 || phase >= config.factor) {
      throw new RangeError(`phase must lie in [0, ${config.factor - 1}], got ${phase}`);
    }
    return { factor: config.factor, phase };
  }

  /** Current decimation factor. */
  get factor(): number {
    return this.currentFactor;
  }

  /** Decimators have zero group delay. */
  get groupDelay(): number {
    return 0;
  }

  /** Number of samples consumed so far (never reset). */
  get consumed(): number {
    return this.count;
  }

  scheduleSwitch(sw: DecimatorSwitch): void {
    assertInteger('switch sample number', sw.at);
    Decimator.normalize(sw.config);
    let i = this.switches.length;
    while (i > 0 && this.switches[i - 1].at > sw.at) i--;
    this.switches.splice(i, 0, sw);
  }

  processBlock(input: readonly Sample[]): Sample[] {
    const out: Sample[] = [];
    for (const s of input) {
      while (this.switches.length > 0 && s.time >= this.switches[0].at) {
        const sw = this.switches.shift()!;
        const normalized = Decimator.normalize(sw.config);
        this.currentFactor = normalized.factor;
        this.currentPhase = normalized.phase;
      }
      if (this.count % this.currentFactor === this.currentPhase) out.push(s);
      this.count++;
    }
    return out;
  }
}
