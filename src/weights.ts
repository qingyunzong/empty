/**
 * 权重模型：有效权重 = 输入权重 × 时间相位因子 × 缺测邻近因子。
 * 邻近因子由该样本前后最近缺测位置的距离共同决定。
 */

/** 时间相位周期：相位因子在 1..PHASE_PERIOD 间循环。 */
export const PHASE_PERIOD = 4;

/** 缺测距离上限：超过该距离（或触及序列边界）按 GAP_CAP 计。 */
export const GAP_CAP = 3;

export function phaseFactor(t: number): number {
  if (!Number.isInteger(t) || t < 0) {
    throw new RangeError("time position must be a non-negative integer");
  }
  return 1 + (t % PHASE_PERIOD);
}

/**
 * 从位置 t 沿 dir 方向寻找最近缺测单元的距离（按时间位置计）。
 * 在 GAP_CAP 步内未遇到缺测（含触及序列边界）时返回 GAP_CAP。
 */
export function distanceToMissing(
  cells: readonly unknown[],
  t: number,
  dir: -1 | 1,
): number {
  for (let d = 1; d <= GAP_CAP; d++) {
    const i = t + dir * d;
    if (i < 0 || i >= cells.length) return GAP_CAP;
    if (cells[i] === null) return d;
  }
  return GAP_CAP;
}

/** 缺测邻近因子：前后距离共同决定。 */
export function proximityFactor(dBefore: number, dAfter: number): number {
  return (1 + dBefore) * (1 + dAfter);
}

/** 有效权重：输入权重 × 相位因子 × 邻近因子（仍为非负整数）。 */
export function effectiveWeight(
  baseWeight: number,
  t: number,
  dBefore: number,
  dAfter: number,
): number {
  return baseWeight * phaseFactor(t) * proximityFactor(dBefore, dAfter);
}
