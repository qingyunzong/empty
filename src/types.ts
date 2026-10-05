/**
 * A sample travelling through the chain, annotated with its position in
 * original (input-stream) time and with the range of original input samples
 * that contributed to its value.
 */
export interface Sample {
  /** Integer sample value. */
  readonly value: number;
  /**
   * Position of this sample in original input time. For raw input samples
   * this is the input index. FIR outputs are stamped at the group-delay
   * position of the filter (fractional, e.g. x.5, for even-length
   * linear-phase filters). Decimators pass the stamp through unchanged.
   */
  readonly time: number;
  /** First original input index that contributed to `value`. */
  readonly srcFirst: number;
  /** Last original input index that contributed to `value`. */
  readonly srcLast: number;
}

/**
 * What happens to the FIR delay line ("old tail") when a scheduled
 * configuration switch takes effect:
 *
 * - `'keep'` (default): the delay line is preserved. The new coefficients
 *   are applied to a window that still contains pre-switch samples, so the
 *   first `n - 1` outputs after the switch are a transient mixing old data
 *   with new coefficients. If the new filter is shorter, the oldest surplus
 *   entries are dropped; if it is longer, the missing history is zero.
 * - `'zero'`: the delay line is cleared at the switch. The first `n - 1`
 *   outputs after the switch treat pre-switch history as zeros, and
 *   `srcFirst` of those outputs excludes the cleared samples.
 */
export type TailPolicy = 'keep' | 'zero';

export function assertInteger(name: string, v: number): void {
  if (!Number.isInteger(v)) {
    throw new TypeError(`${name} must be an integer, got ${v}`);
  }
}
