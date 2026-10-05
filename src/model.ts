/**
 * 参照模型：排序计数法求范围众数。
 * 与 VersionedArray.rangeMode 的 Map 扫描实现相互独立，用于交叉核对。
 */

export interface ModelMode {
  readonly value: number;
  readonly frequency: number;
}

/** 排序计数：切片 → 数值升序排序 → 扫描等值游程；严格大于才替换，故并列保留较小值。 */
export function sortedCountingMode(
  arr: readonly number[],
  from: number,
  to: number,
): ModelMode | null {
  if (from > to) return null; // 空范围
  const slice = arr.slice(from, to + 1).sort((a, b) => a - b);

  let bestValue = slice[0]!;
  let bestCount = 1;
  let runValue = slice[0]!;
  let runCount = 1;
  for (let i = 1; i < slice.length; i++) {
    const v = slice[i]!;
    if (v === runValue) {
      runCount += 1;
    } else {
      if (runCount > bestCount) {
        bestCount = runCount;
        bestValue = runValue;
      }
      runValue = v;
      runCount = 1;
    }
  }
  if (runCount > bestCount) {
    bestCount = runCount;
    bestValue = runValue;
  }
  return { value: bestValue, frequency: bestCount };
}

/** 独立计数器：直接数 value 在 [from, to] 中的出现次数（用于核验证据频次）。 */
export function countOccurrences(
  arr: readonly number[],
  from: number,
  to: number,
  value: number,
): number {
  let n = 0;
  for (let i = from; i <= to; i++) {
    if (arr[i] === value) n += 1;
  }
  return n;
}
