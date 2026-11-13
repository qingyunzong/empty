/**
 * Key-group 区间计算，语义与 Flink KeyGroupRangeAssignment 一致：
 * 在 maxParallelism 固定的 key-group 空间 [0, maxParallelism) 内，
 * 并行度为 parallelism 的第 index 个 subtask 拥有连续区间
 * [floor(index*m/p), floor((index+1)*m/p) - 1]。
 * 该划分保证每个 key-group 恰好归属一个 subtask。
 */

export interface KeyGroupRange {
  /** 起始 key-group（含） */
  start: number;
  /** 结束 key-group（含） */
  end: number;
}

export function computeKeyGroupRange(
  maxParallelism: number,
  parallelism: number,
  operatorIndex: number,
): KeyGroupRange {
  assertValidParallelism(maxParallelism, parallelism);
  if (!Number.isInteger(operatorIndex) || operatorIndex < 0 || operatorIndex >= parallelism) {
    throw new Error(
      `operatorIndex ${operatorIndex} 越界：parallelism=${parallelism}`,
    );
  }
  const start = Math.floor((operatorIndex * maxParallelism) / parallelism);
  const end = Math.floor(((operatorIndex + 1) * maxParallelism) / parallelism) - 1;
  return { start, end };
}

export function assertValidParallelism(
  maxParallelism: number,
  parallelism: number,
): void {
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new Error(`非法 parallelism：${parallelism}（必须为 >= 1 的整数）`);
  }
  if (!Number.isInteger(maxParallelism) || maxParallelism < 1) {
    throw new Error(`非法 maxParallelism：${maxParallelism}（必须为 >= 1 的整数）`);
  }
  if (parallelism > maxParallelism) {
    throw new Error(
      `parallelism (${parallelism}) 不能大于 maxParallelism (${maxParallelism})`,
    );
  }
}

export function intersects(a: KeyGroupRange, b: KeyGroupRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function intersection(
  a: KeyGroupRange,
  b: KeyGroupRange,
): KeyGroupRange | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start <= end ? { start, end } : null;
}

export function rangeSize(range: KeyGroupRange): number {
  return range.end - range.start + 1;
}

/**
 * 校验一组区间是否将 [0, maxParallelism) 恰好划分一次：
 * 无重叠、无空洞、无越界。合法时返回 null，否则返回违规描述。
 */
export function checkExactOnceCoverage(
  ranges: readonly KeyGroupRange[],
  maxParallelism: number,
): string | null {
  const owner = new Array<number>(maxParallelism).fill(-1);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start < 0 || r.end >= maxParallelism || r.start > r.end) {
      return `区间 [${r.start}, ${r.end}] 越出 key-group 空间 [0, ${maxParallelism - 1}]`;
    }
    for (let g = r.start; g <= r.end; g++) {
      if (owner[g] !== -1) {
        return `key-group ${g} 被重复分配（区间 #${owner[g]} 与 #${i}）`;
      }
      owner[g] = i;
    }
  }
  for (let g = 0; g < maxParallelism; g++) {
    if (owner[g] === -1) {
      return `key-group ${g} 未被任何 subtask 覆盖`;
    }
  }
  return null;
}
