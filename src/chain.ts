import { Fir } from './fir.js';
import { Decimator } from './decimator.js';
import type { Sample } from './types.js';
import { assertInteger } from './types.js';

export type Stage = Fir | Decimator;

/**
 * A cascade of FIR and decimator stages. `push` feeds a block of integer
 * input samples and returns the annotated output samples produced by the
 * final stage. All state lives in the stages, so results are independent of
 * how the input is split into blocks.
 *
 * Each returned sample carries:
 * - `time`:     its position in original input time (all stage delays and
 *               decimation factors mapped back);
 * - `srcFirst` / `srcLast`: the range of original input indices whose
 *               values contributed to this output.
 */
export class Chain {
  readonly stages: readonly Stage[];
  private nextIndex = 0;

  constructor(stages: readonly Stage[]) {
    if (stages.length === 0) {
      throw new RangeError('chain needs at least one stage');
    }
    this.stages = [...stages];
  }

  /** Original-time index the next pushed sample will receive. */
  get nextInputIndex(): number {
    return this.nextIndex;
  }

  push(values: readonly number[]): Sample[] {
    let samples: Sample[] = values.map((v) => {
      assertInteger('input sample', v);
      const i = this.nextIndex++;
      return { value: v, time: i, srcFirst: i, srcLast: i };
    });
    for (const stage of this.stages) samples = stage.processBlock(samples);
    return samples;
  }

  /**
   * Per-stage group delay mapped to original input time, for the current
   * configuration: a stage's local delay is multiplied by the decimation
   * accumulated in front of it. Decimators contribute 0.
   */
  stageDelays(): number[] {
    const delays: number[] = [];
    let decimation = 1;
    for (const stage of this.stages) {
      delays.push(stage.groupDelay * decimation);
      if (stage instanceof Decimator) decimation *= stage.factor;
    }
    return delays;
  }

  /** Total chain delay in original input samples (current configuration). */
  totalDelay(): number {
    return this.stageDelays().reduce((a, b) => a + b, 0);
  }

  /** Product of all decimation factors (current configuration). */
  totalDecimation(): number {
    let d = 1;
    for (const stage of this.stages) {
      if (stage instanceof Decimator) d *= stage.factor;
    }
    return d;
  }
}
