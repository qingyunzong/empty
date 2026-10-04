/**
 * A sample travelling through the chain. `value` is an integer.
 * `first` / `last` / `center` are indices in the ORIGINAL input time base
 * (i.e. sample numbers of the chain input, before any decimation).
 */
export interface Sample {
  /** Integer sample value. */
  readonly value: number;
  /** Earliest original input index that contributed to `value`. */
  readonly first: number;
  /** Latest original input index that contributed to `value`. */
  readonly last: number;
  /** Original-time index this sample is aligned to (group delay mapped back). */
  readonly center: number;
}

/**
 * How the pending tail (samples still sitting in FIR delay lines) is treated
 * at a configuration switch or at end-of-stream:
 *
 * - 'drop':  the tail is discarded. With an M-tap FIR the last M-1 outputs
 *            are never emitted. Decimators never emit a tail: an incomplete
 *            decimation period is always dropped.
 * - 'flush': each FIR emits its remaining M-1 outputs by zero-padding the
 *            input with M-1 zeros, still using the OLD coefficients. Flushed
 *            samples propagate through the rest of the (old) chain. Zero
 *            padding contributes nothing to `first`/`last`; flushed `center`
 *            values are extrapolated with the last observed center step and
 *            may lie past the final input index.
 */
export type TailPolicy = 'drop' | 'flush';

export interface FirConfig {
  readonly kind: 'fir';
  /**
   * Integer coefficients. Must be of odd length and symmetric
   * (linear phase), so the group delay (length-1)/2 is an integer and the
   * delay can be mapped back to an exact original-time sample index.
   */
  readonly taps: readonly number[];
}

export interface DecimateConfig {
  readonly kind: 'decimate';
  /** Integer decimation factor R >= 1. */
  readonly factor: number;
  /**
   * Keep inputs with local index i where i % R === phase.
   * 0 <= phase < R. Defaults to 0.
   */
  readonly phase?: number;
}

export type StageConfig = FirConfig | DecimateConfig;
