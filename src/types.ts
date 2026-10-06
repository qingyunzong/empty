/** 一个质量档：两类资源消耗与收益。档 0 约定为“不服务”（0 消耗 0 收益）。 */
export interface Tier {
  r1: number;
  r2: number;
  profit: number;
}

/** 组合收益：用户 i 选档 ti 且用户 j 选档 tj 时，额外获得 bonus（可为负）。 */
export interface Combo {
  i: number;
  j: number;
  ti: number;
  tj: number;
  bonus: number;
}

export interface Problem {
  /** users[u][t]：用户 u 的第 t 档；t=0 必须为不服务档。用户数 1..16。 */
  users: Tier[][];
  budget1: number;
  budget2: number;
  combos: Combo[];
  /** 必须同档的用户对 [i, j]。 */
  sameTier: [number, number][];
  /** 必须分档（档索引不同）的用户对 [i, j]。 */
  diffTier: [number, number][];
}

export interface Solution {
  assign: number[];
  profit: number;
  baseProfit: number;
  comboProfit: number;
  used1: number;
  used2: number;
  /** 处于各自最高档的用户数（第二优化目标）。 */
  highCount: number;
}

export function validateProblem(p: Problem): void {
  if (!p || !Array.isArray(p.users)) throw new Error("问题缺少 users 数组");
  const n = p.users.length;
  if (n < 1 || n > 16) throw new Error(`用户数须为 1..16，实际 ${n}`);
  for (const [u, tiers] of p.users.entries()) {
    if (!Array.isArray(tiers) || tiers.length < 1) throw new Error(`用户${u}至少需要一个档（档0=不服务）`);
    for (const [t, tier] of tiers.entries()) {
      for (const k of ["r1", "r2", "profit"] as const) {
        if (typeof tier[k] !== "number" || !Number.isFinite(tier[k]) || tier[k] < 0)
          throw new Error(`用户${u}档${t}的 ${k} 非法：${tier[k]}`);
      }
    }
    const z = tiers[0];
    if (z.r1 !== 0 || z.r2 !== 0 || z.profit !== 0) throw new Error(`用户${u}的档0必须为不服务档(0,0,0)`);
  }
  for (const [name, b] of [["budget1", p.budget1], ["budget2", p.budget2]] as const) {
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 100)
      throw new Error(`${name} 须为 0..100 的整数，实际 ${b}`);
  }
  const checkUser = (u: number, where: string) => {
    if (!Number.isInteger(u) || u < 0 || u >= n) throw new Error(`${where} 引用了非法用户 ${u}`);
  };
  for (const [k, c] of (p.combos ?? []).entries()) {
    checkUser(c.i, `组合${k}`); checkUser(c.j, `组合${k}`);
    if (c.i === c.j) throw new Error(`组合${k}的两个用户相同`);
    if (!Number.isInteger(c.ti) || c.ti < 0 || c.ti >= p.users[c.i].length) throw new Error(`组合${k}的 ti 越界`);
    if (!Number.isInteger(c.tj) || c.tj < 0 || c.tj >= p.users[c.j].length) throw new Error(`组合${k}的 tj 越界`);
    if (typeof c.bonus !== "number" || !Number.isFinite(c.bonus)) throw new Error(`组合${k}的 bonus 非法`);
  }
  for (const [kind, pairs] of [["sameTier", p.sameTier ?? []], ["diffTier", p.diffTier ?? []]] as const) {
    for (const [k, [i, j]] of pairs.entries()) {
      checkUser(i, `${kind}[${k}]`); checkUser(j, `${kind}[${k}]`);
      if (i === j) throw new Error(`${kind}[${k}] 的两个用户相同`);
    }
  }
}

/** 由分配向量计算完整解（不做可行性判断）。 */
export function evaluate(p: Problem, assign: number[]): Solution {
  let baseProfit = 0, used1 = 0, used2 = 0, highCount = 0;
  for (let u = 0; u < p.users.length; u++) {
    const t = assign[u];
    const tier = p.users[u][t];
    if (!tier) throw new Error(`用户${u}的档${t}越界`);
    baseProfit += tier.profit;
    used1 += tier.r1;
    used2 += tier.r2;
    if (t === p.users[u].length - 1) highCount++;
  }
  let comboProfit = 0;
  for (const c of p.combos) {
    if (assign[c.i] === c.ti && assign[c.j] === c.tj) comboProfit += c.bonus;
  }
  return { assign: [...assign], profit: baseProfit + comboProfit, baseProfit, comboProfit, used1, used2, highCount };
}

export function feasible(p: Problem, assign: number[]): boolean {
  const s = evaluate(p, assign);
  if (s.used1 > p.budget1 || s.used2 > p.budget2) return false;
  for (const [i, j] of p.sameTier) if (assign[i] !== assign[j]) return false;
  for (const [i, j] of p.diffTier) if (assign[i] === assign[j]) return false;
  return true;
}

/**
 * 字典序目标比较：返回 >0 表示 a 更优。
 * 1) 总收益大者优；2) 最高档用户数多者优；3) 分配向量字典序小者优。
 */
export function compareSolutions(a: Solution, b: Solution): number {
  if (a.profit !== b.profit) return a.profit - b.profit;
  if (a.highCount !== b.highCount) return a.highCount - b.highCount;
  for (let i = 0; i < a.assign.length; i++) {
    if (a.assign[i] !== b.assign[i]) return b.assign[i] - a.assign[i];
  }
  return 0;
}
