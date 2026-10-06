import { Problem, Solution, compareSolutions, evaluate, validateProblem } from "./types.js";

/** DFS 栈帧：正准备为用户 u 选档，nextTier 为下一个待尝试的档。 */
interface Frame {
  u: number;
  nextTier: number;
  used1: number;
  used2: number;
  profit: number;
  high: number;
  assign: number[];
}

/** 可序列化的搜索检查点：保存后可在任意时刻恢复，结果与不暂停完全一致。 */
export interface Checkpoint {
  version: 1;
  problem: Problem;
  problemHash: string;
  stack: Frame[];
  best: Solution | null;
  nodes: number;
}

export function hashProblem(p: Problem): string {
  const s = JSON.stringify(p);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface ComboRef {
  other: number;
  tierThis: number;
  tierOther: number;
  bonus: number;
}

/**
 * 确定性分支限界求解器。
 * 用户按 0..n-1 顺序、档按升序尝试，因此叶节点按分配向量字典序枚举；
 * 结合“仅严格更优才替换”的更新规则，保证第三目标（向量小）正确。
 */
export class Solver {
  private readonly p: Problem;
  private readonly n: number;
  private stack: Frame[];
  private best: Solution | null;
  private nodes: number;
  private readonly combosByUser: ComboRef[][];
  private readonly sameByUser: number[][];
  private readonly diffByUser: number[][];
  private readonly maxTierIdx: number[];
  /** maxProfitSuffix[u] = 用户 u..n-1 的最大单档收益之和。 */
  private readonly maxProfitSuffix: number[];
  /** comboSuffix[u] = 两个端点最大编号 >= u 的组合的正 bonus 之和（未决组合的乐观上界）。 */
  private readonly comboSuffix: number[];

  constructor(problem: Problem) {
    validateProblem(problem);
    this.p = problem;
    this.n = problem.users.length;
    this.stack = [{ u: 0, nextTier: 0, used1: 0, used2: 0, profit: 0, high: 0, assign: [] }];
    this.best = null;
    this.nodes = 0;

    this.combosByUser = Array.from({ length: this.n }, () => []);
    for (const c of this.p.combos) {
      this.combosByUser[c.i].push({ other: c.j, tierThis: c.ti, tierOther: c.tj, bonus: c.bonus });
      this.combosByUser[c.j].push({ other: c.i, tierThis: c.tj, tierOther: c.ti, bonus: c.bonus });
    }
    this.sameByUser = Array.from({ length: this.n }, () => []);
    this.diffByUser = Array.from({ length: this.n }, () => []);
    for (const [i, j] of this.p.sameTier) { this.sameByUser[i].push(j); this.sameByUser[j].push(i); }
    for (const [i, j] of this.p.diffTier) { this.diffByUser[i].push(j); this.diffByUser[j].push(i); }

    this.maxTierIdx = this.p.users.map((tiers) => tiers.length - 1);
    this.maxProfitSuffix = new Array(this.n + 1).fill(0);
    for (let u = this.n - 1; u >= 0; u--) {
      const mx = Math.max(...this.p.users[u].map((t) => t.profit));
      this.maxProfitSuffix[u] = this.maxProfitSuffix[u + 1] + mx;
    }
    this.comboSuffix = new Array(this.n + 1).fill(0);
    for (let u = this.n - 1; u >= 0; u--) {
      this.comboSuffix[u] = this.comboSuffix[u + 1];
      for (const c of this.p.combos) {
        if (Math.max(c.i, c.j) === u && c.bonus > 0) this.comboSuffix[u] += c.bonus;
      }
    }
  }

  static fromCheckpoint(cp: Checkpoint, problem?: Problem): Solver {
    if (cp.version !== 1) throw new Error(`不支持的检查点版本 ${cp.version}`);
    const p = problem ?? cp.problem;
    if (hashProblem(p) !== cp.problemHash) throw new Error("检查点与问题不匹配（hash 不一致）");
    const s = new Solver(p);
    s.stack = cp.stack.map((f) => ({ ...f, assign: [...f.assign] }));
    s.best = cp.best ? { ...cp.best, assign: [...cp.best.assign] } : null;
    s.nodes = cp.nodes;
    return s;
  }

  checkpoint(): Checkpoint {
    return JSON.parse(JSON.stringify({
      version: 1,
      problem: this.p,
      problemHash: hashProblem(this.p),
      stack: this.stack,
      best: this.best,
      nodes: this.nodes,
    }));
  }

  get nodeCount(): number { return this.nodes; }
  get done(): boolean { return this.stack.length === 0; }

  /** 处理一个搜索节点；返回 false 表示搜索已结束。 */
  step(): boolean {
    if (this.done) return false;
    this.nodes++;
    const f = this.stack[this.stack.length - 1];
    const u = f.u;
    if (f.nextTier >= this.p.users[u].length) {
      this.stack.pop();
      return !this.done;
    }
    const t = f.nextTier++;
    const tier = this.p.users[u][t];

    if (f.used1 + tier.r1 > this.p.budget1 || f.used2 + tier.r2 > this.p.budget2) return true;
    for (const v of this.sameByUser[u]) if (v < u && f.assign[v] !== t) return true;
    for (const v of this.diffByUser[u]) if (v < u && f.assign[v] === t) return true;

    let add = tier.profit;
    for (const c of this.combosByUser[u]) {
      if (c.other < u && c.tierThis === t && f.assign[c.other] === c.tierOther) add += c.bonus;
    }
    const profit = f.profit + add;
    const used1 = f.used1 + tier.r1;
    const used2 = f.used2 + tier.r2;
    const high = f.high + (t === this.maxTierIdx[u] ? 1 : 0);
    const assign = [...f.assign, t];

    if (u === this.n - 1) {
      const sol = evaluate(this.p, assign);
      if (!this.best || compareSolutions(sol, this.best) > 0) this.best = sol;
      return true;
    }

    if (this.best) {
      const boundProfit = profit + this.maxProfitSuffix[u + 1] + this.comboSuffix[u + 1];
      const boundHigh = high + (this.n - 1 - u);
      if (boundProfit < this.best.profit) return true;
      if (boundProfit === this.best.profit && boundHigh < this.best.highCount) return true;
    }
    this.stack.push({ u: u + 1, nextTier: 0, used1, used2, profit, high, assign });
    return true;
  }

  /** 最多执行 maxSteps 步；返回是否已完成。 */
  run(maxSteps = Infinity): boolean {
    let steps = 0;
    while (!this.done && steps < maxSteps) { this.step(); steps++; }
    return this.done;
  }

  /** 搜索完成后的最优解；无可行解（理论上仅当约束排除“全部不服务”）时返回 null。 */
  result(): Solution | null {
    if (!this.done) throw new Error("搜索尚未完成，不能取结果");
    return this.best ? { ...this.best, assign: [...this.best.assign] } : null;
  }
}
