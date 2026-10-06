/**
 * 问题模型：为 <=16 个用户各选一个质量档（或“不服务”）。
 * 每个档消耗两类资源并产生收益；总资源不超过预算（<=100）。
 * 用户之间可有组合收益（pair bonus）以及“必须同档 / 必须分离档”限制。
 */

export interface Tier {
  /** 资源 1 消耗 */
  r1: number;
  /** 资源 2 消耗 */
  r2: number;
  /** 选择该档产生的收益 */
  benefit: number;
}

/** 用户 i 取档 a、用户 j 取档 b 时的组合收益（归一化后保证 i < j）。 */
export interface PairBonus {
  i: number;
  j: number;
  a: number;
  b: number;
  bonus: number;
}

/**
 * same: 两用户都被服务时必须同档；diff: 两用户都被服务时必须不同档。
 * 任一方未被服务时约束自动满足（vacuously satisfied）。
 */
export interface Constraint {
  kind: 'same' | 'diff';
  i: number;
  j: number;
}

export interface Problem {
  users: number; // 0..16
  tiers: Tier[]; // 档按数组下标编号 0..T-1，下标越大档越高
  budget1: number;
  budget2: number;
  pairBonuses?: PairBonus[];
  constraints?: Constraint[];
}

/** 分配向量中“不服务”的取值。 */
export const UNSERVED = -1;
export type Assignment = number[];

export interface NormalizedProblem {
  users: number;
  tiers: Tier[];
  budget1: number;
  budget2: number;
  /** key = `${i},${a},${j},${b}`（i<j），value = 该组合的总 bonus */
  bonus: Map<string, number>;
  constraints: Constraint[];
  /** 单用户最大档收益（>=0），用于上界剪枝 */
  maxTierBenefit: number;
}

export function bonusKey(i: number, a: number, j: number, b: number): string {
  return `${i},${a},${j},${b}`;
}

export function normalize(p: Problem): NormalizedProblem {
  if (!Number.isInteger(p.users) || p.users < 0 || p.users > 16) {
    throw new Error(`users must be an integer in [0,16], got ${p.users}`);
  }
  if (!Array.isArray(p.tiers)) throw new Error('tiers must be an array');
  if (!(p.budget1 >= 0) || !(p.budget2 >= 0)) throw new Error('budgets must be >= 0');
  p.tiers.forEach((t, idx) => {
    if (!(t.r1 >= 0) || !(t.r2 >= 0)) throw new Error(`tier ${idx}: consumption must be >= 0`);
  });
  const bonus = new Map<string, number>();
  for (const pb of p.pairBonuses ?? []) {
    let { i, j, a, b } = pb;
    if (i === j) throw new Error(`pair bonus with i==j (${i})`);
    if (i > j) { [i, j] = [j, i]; [a, b] = [b, a]; }
    checkUser(p, i); checkUser(p, j); checkTier(p, a); checkTier(p, b);
    const k = bonusKey(i, a, j, b);
    bonus.set(k, (bonus.get(k) ?? 0) + pb.bonus);
  }
  const constraints = (p.constraints ?? []).map((c) => {
    checkUser(p, c.i); checkUser(p, c.j);
    if (c.i === c.j) throw new Error(`constraint with i==j (${c.i})`);
    if (c.kind !== 'same' && c.kind !== 'diff') throw new Error(`bad constraint kind ${c.kind}`);
    return { kind: c.kind, i: Math.min(c.i, c.j), j: Math.max(c.i, c.j) };
  });
  const maxTierBenefit = Math.max(0, ...p.tiers.map((t) => t.benefit));
  return { users: p.users, tiers: p.tiers, budget1: p.budget1, budget2: p.budget2, bonus, constraints, maxTierBenefit };
}

function checkUser(p: Problem, u: number): void {
  if (!Number.isInteger(u) || u < 0 || u >= p.users) throw new Error(`user index out of range: ${u}`);
}
function checkTier(p: Problem, t: number): void {
  if (!Number.isInteger(t) || t < 0 || t >= p.tiers.length) throw new Error(`tier index out of range: ${t}`);
}

/** 一个完整解的评估结果。 */
export interface Evaluated {
  assignment: Assignment;
  benefit: number;
  used1: number;
  used2: number;
}

/** 计算分配向量的收益（档收益 + 命中的组合收益）与两类资源用量。 */
export function evaluate(np: NormalizedProblem, assignment: Assignment): Evaluated {
  let benefit = 0, used1 = 0, used2 = 0;
  for (let u = 0; u < np.users; u++) {
    const t = assignment[u];
    if (t === UNSERVED) continue;
    const tier = np.tiers[t];
    benefit += tier.benefit; used1 += tier.r1; used2 += tier.r2;
  }
  for (let i = 0; i < np.users; i++) {
    const a = assignment[i];
    if (a === UNSERVED) continue;
    for (let j = i + 1; j < np.users; j++) {
      const b = assignment[j];
      if (b === UNSERVED) continue;
      benefit += np.bonus.get(bonusKey(i, a, j, b)) ?? 0;
    }
  }
  return { assignment: assignment.slice(), benefit, used1, used2 };
}

/** 检查单条约束（双方都未服务/一方未服务时视为满足）。 */
export function constraintHolds(c: Constraint, assignment: Assignment): boolean {
  const ti = assignment[c.i], tj = assignment[c.j];
  if (ti === UNSERVED || tj === UNSERVED) return true;
  return c.kind === 'same' ? ti === tj : ti !== tj;
}

export function allConstraintsHold(np: NormalizedProblem, assignment: Assignment): boolean {
  return np.constraints.every((c) => constraintHolds(c, assignment));
}

/**
 * 解的优劣比较（返回负数表示 a 更优）：
 *  1. 总收益大者优；
 *  2. 从最高档向下逐档比较在档人数，高档人数多者优；
 *  3. 分配向量字典序小者优（UNSERVED=-1 最小）。
 */
export function compareEvaluated(np: NormalizedProblem, a: Evaluated, b: Evaluated): number {
  if (a.benefit !== b.benefit) return b.benefit - a.benefit;
  for (let t = np.tiers.length - 1; t >= 0; t--) {
    const ca = countTier(a.assignment, t);
    const cb = countTier(b.assignment, t);
    if (ca !== cb) return cb - ca;
  }
  for (let u = 0; u < a.assignment.length; u++) {
    if (a.assignment[u] !== b.assignment[u]) return a.assignment[u] - b.assignment[u];
  }
  return 0;
}

function countTier(assignment: Assignment, t: number): number {
  let n = 0;
  for (const x of assignment) if (x === t) n++;
  return n;
}

/** 稳定的 JSON 序列化（键排序），用于断点文件中的问题指纹。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}
