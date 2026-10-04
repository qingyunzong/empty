import { DecimateConfig, FirConfig, Sample, StageConfig, TailPolicy } from './sample';
import { DecimateStage, FirStage, Stage } from './stages';

export interface ChainTiming {
  /** Output period in original input samples (product of decimation factors). */
  readonly outPeriod: number;
  /**
   * Total latency mapped to original input samples: with a stream starting at
   * input index 0, chain output #m is aligned to original time
   * `latency + m * outPeriod`.
   */
  readonly latency: number;
}

function buildStage(config: StageConfig): Stage {
  return config.kind === 'fir' ? new FirStage(config) : new DecimateStage(config);
}

/**
 * A streaming chain of integer FIR filters and decimators.
 *
 * - State persists across push() calls: block boundaries never reset state,
 *   so any blocking of the same input yields the same output.
 * - Every output Sample carries its source range (`first`/`last`) and its
 *   alignment (`center`) in the original input time base.
 * - Configuration switches take effect only at an explicit sample number via
 *   reconfigure(); the old tail is handled according to `tailPolicy`.
 */
export class Chain {
  private stages: Stage[];
  private config: StageConfig[];
  private nextIndex = 0;
  private finished = false;
  readonly tailPolicy: TailPolicy;

  constructor(config: readonly StageConfig[], tailPolicy: TailPolicy = 'drop') {
    if (config.length === 0) throw new Error('chain: config must contain at least one stage');
    this.tailPolicy = tailPolicy;
    this.config = config.slice();
    this.stages = config.map(buildStage);
  }

  /**
   * Push one block of integer input samples. Returns the chain outputs
   * emitted while processing this block (possibly none).
   */
  push(block: readonly number[]): Sample[] {
    if (this.finished) throw new Error('chain: cannot push after finish()');
    let current: Sample[] = block.map((value, i) => {
      if (!Number.isInteger(value)) throw new Error(`chain: input sample ${this.nextIndex + i} is not an integer (${value})`);
      const index = this.nextIndex + i;
      return { value, first: index, last: index, center: index };
    });
    this.nextIndex += block.length;
    for (const stage of this.stages) {
      const out: Sample[] = [];
      for (const s of current) stage.push(s, out);
      current = out;
    }
    return current;
  }

  /**
   * Switch configuration. The new configuration applies to input samples
   * with index >= atSample; `atSample` must equal the number of samples
   * consumed so far, i.e. the switch takes effect exactly at that explicit
   * sample number. Returns the old chain's tail (empty unless the tail
   * policy is 'flush'). The old tail is emitted with the OLD configuration;
   * the new configuration starts with fresh state.
   */
  reconfigure(config: readonly StageConfig[], atSample: number): Sample[] {
    if (this.finished) throw new Error('chain: cannot reconfigure after finish()');
    if (config.length === 0) throw new Error('chain: config must contain at least one stage');
    if (!Number.isInteger(atSample) || atSample !== this.nextIndex) {
      throw new Error(
        `chain: config switch takes effect only at an explicit sample number; ` +
          `expected atSample === ${this.nextIndex} (samples consumed so far), got ${atSample}`,
      );
    }
    const tail = this.drain();
    this.config = config.slice();
    this.stages = this.config.map(buildStage);
    return tail;
  }

  /** End of stream: emits the tail according to the tail policy. */
  finish(): Sample[] {
    if (this.finished) throw new Error('chain: finish() called twice');
    this.finished = true;
    return this.drain();
  }

  /**
   * Delay mapping of the CURRENT configuration: chain output #m is aligned
   * to original input time `latency + m * outPeriod` (for a stream starting
   * at input index 0 with a uniform input rate).
   */
  timing(): ChainTiming {
    let outPeriod = 1;
    let latency = 0;
    for (const stage of this.config) {
      if (stage.kind === 'fir') {
        latency += ((stage.taps.length - 1) / 2) * outPeriod;
      } else {
        latency += (stage.phase ?? 0) * outPeriod;
        outPeriod *= stage.factor;
      }
    }
    return { outPeriod, latency };
  }

  private drain(): Sample[] {
    if (this.tailPolicy === 'drop') return [];
    let pending: Sample[] = [];
    for (const stage of this.stages) {
      const out: Sample[] = [];
      for (const s of pending) stage.push(s, out);
      stage.flush(out);
      pending = out;
    }
    return pending;
  }
}
