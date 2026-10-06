/** 候选解: 比较与更新的基本单位. */
export interface Candidate {
  payoff: number;
  /** 叶拨款总额(不含启动费). */
  total: number;
  /** 按叶序(先序)的拨款向量. */
  amounts: number[];
}

export function lexLess(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/**
 * 全局优胜序: 收益高者优先; 并列则总拨款少者优先; 再并列则叶向量字典序小者优先.
 * 返回负数表示 a 优于 b.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.payoff !== b.payoff) return b.payoff - a.payoff;
  if (a.total !== b.total) return a.total - b.total;
  const n = Math.min(a.amounts.length, b.amounts.length);
  for (let i = 0; i < n; i++) {
    if (a.amounts[i] !== b.amounts[i]) return a.amounts[i] - b.amounts[i];
  }
  return a.amounts.length - b.amounts.length;
}

/** a 是否严格优于 b. */
export function betterThan(a: Candidate, b: Candidate): boolean {
  return compareCandidates(a, b) < 0;
}
