/**
 * 分支定界求解器：显式栈的迭代 DFS，搜索状态可完整序列化，
 * 暂停（步数上限）后保存断点、之后恢复继续，结果与不停顿运行完全一致。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import {
  Assignment, Constraint, Evaluated, NormalizedProblem, Problem,
  UNSERVED, bonusKey, canonicalize, compareEvaluated, normalize,
} from './model';

interface Frame {
  /** 下一个待尝试的选项下标（选项 = [UNSERVED, 0, 1, ..., T-1]） */
  nextOpt: number;
  used1: number;
  used2: number;
  benefit: number;
}

export interface Checkpoint {
  version: 1;
  /** canonicalize(problem)，恢复时校验问题一致性 */
  problem: string;
  stack: Frame[];
  choices: number[];
  best: Evaluated | null;
  nodes: number;
  done: boolean;
}

export class Solver {
  readonly np: NormalizedProblem;
  private readonly options: number[];
  /** suffixTier[k] = 用户 k..n-1 的最大档收益之和（上界） */
  private readonly suffixTier: number[];
  /** suffixPair[k] = 至少一端用户编号 >= k 的组合收益正上界之和 */
  private readonly suffixPair: number[];
  private readonly constraintsOf: Constraint[][];

  private stack: Frame[] = [];
  private choices: number[] = [];
  private best: Evaluated | null = null;
  private nodes = 0;
  private done = false;

  constructor(problem: Problem) {
    this.np = normalize(problem);
    this.options = [UNSERVED, ...this.np.tiers.map((_, i) => i)];
    const n = this.np.users;
    this.suffixTier = new Array(n + 1).fill(0);
    for (let k = n - 1; k >= 0; k--) this.suffixTier[k] = this.suffixTier[k + 1] + this.np.maxTierBenefit;
    // 每对 (i,j)（i<j）的正收益上界
    const pairMax = new Map<string, number>();
    for (const [key, v] of this.np.bonus) {
      const [i, , j] = key.split(',').map(Number);
      const pk = `${i},${j}`;
      pairMax.set(pk, Math.max(pairMax.get(pk) ?? 0, v));
    }
    this.suffixPair = new Array(n + 1).fill(0);
    for (const [pk, v] of pairMax) {
      if (v <= 0) continue;
      const j = Number(pk.split(',')[1]);
      for (let k = 0; k <= j; k++) this.suffixPair[k] += v;
    }
    this.constraintsOf = Array.from({ length: n }, () => []);
    for (const c of this.np.constraints) {
      this.constraintsOf[c.i].push(c);
      this.constraintsOf[c.j].push(c);
    }
    if (n === 0) {
      this.best = { assignment: [], benefit: 0, used1: 0, used2: 0 };
      this.done = true;
    } else {
      this.stack.push({ nextOpt: 0, used1: 0, used2: 0, benefit: 0 });
    }
  }

  get nodeCount(): number { return this.nodes; }
  get isDone(): boolean { return this.done; }
  getBest(): Evaluated | null { return this.best; }

  /** 运行直到完成或已扩展节点数达到 maxNodes（暂停）。 */
  run(maxNodes = Infinity): void {
    const np = this.np;
    const n = np.users;
    while (!this.done && this.stack.length > 0) {
      if (this.nodes >= maxNodes) return;
      const d = this.stack.length - 1;
      const frame = this.stack[d];
      let descended = false;
      while (frame.nextOpt < this.options.length) {
        const opt = this.options[frame.nextOpt++];
        const tier = opt === UNSERVED ? null : np.tiers[opt];
        const u1 = frame.used1 + (tier?.r1 ?? 0);
        const u2 = frame.used2 + (tier?.r2 ?? 0);
        if (u1 > np.budget1 || u2 > np.budget2) continue;
        if (opt !== UNSERVED && !this.constraintsOk(d, opt)) continue;
        this.choices[d] = opt;
        this.nodes++;
        let gain = tier?.benefit ?? 0;
        if (opt !== UNSERVED) gain += this.pairGain(d, opt);
        const nb = frame.benefit + gain;
        if (d === n - 1) {
          const ev: Evaluated = { assignment: this.choices.slice(0, n), benefit: nb, used1: u1, used2: u2 };
          if (this.best === null || compareEvaluated(np, ev, this.best) < 0) this.best = ev;
        } else {
          const bound = nb + this.suffixTier[d + 1] + this.suffixPair[d + 1];
          const bestBenefit = this.best?.benefit ?? -Infinity;
          if (bound >= bestBenefit) {
            this.stack.push({ nextOpt: 0, used1: u1, used2: u2, benefit: nb });
            descended = true;
          }
        }
        break; // 回到循环顶，检查步数上限
      }
      if (!descended && frame.nextOpt >= this.options.length) {
        this.stack.pop();
        this.choices.length = d;
      }
    }
    if (this.stack.length === 0) this.done = true;
  }

  /** 用户 d 取档 opt 时，与已分配用户（编号 < d）的约束是否满足。 */
  private constraintsOk(d: number, opt: number): boolean {
    for (const c of this.constraintsOf[d]) {
      const other = c.i === d ? c.j : c.i;
      if (other >= d) continue;
      const co = this.choices[other];
      if (co === UNSERVED) continue;
      if (c.kind === 'same' && co !== opt) return false;
      if (c.kind === 'diff' && co === opt) return false;
    }
    return true;
  }

  /** 用户 d 取档 opt 时，与已分配用户之间命中的组合收益之和。 */
  private pairGain(d: number, opt: number): number {
    let g = 0;
    for (let j = 0; j < d; j++) {
      const cj = this.choices[j];
      if (cj === UNSERVED) continue;
      g += this.np.bonus.get(bonusKey(j, cj, d, opt)) ?? 0;
    }
    return g;
  }

  toCheckpoint(problem: Problem): Checkpoint {
    return {
      version: 1,
      problem: canonicalize(problem),
      stack: this.stack.map((f) => ({ ...f })),
      choices: this.choices.slice(),
      best: this.best ? { ...this.best, assignment: this.best.assignment.slice() } : null,
      nodes: this.nodes,
      done: this.done,
    };
  }

  saveToFile(problem: Problem, file: string): void {
    writeFileSync(file, JSON.stringify(this.toCheckpoint(problem)));
  }

  static fromCheckpoint(problem: Problem, cp: Checkpoint): Solver {
    if (cp.version !== 1) throw new Error(`unsupported checkpoint version ${cp.version}`);
    if (cp.problem !== canonicalize(problem)) {
      throw new Error('checkpoint was created for a different problem');
    }
    const s = new Solver(problem);
    s.stack = cp.stack.map((f) => ({ ...f }));
    s.choices = cp.choices.slice();
    s.best = cp.best ? { ...cp.best, assignment: cp.best.assignment.slice() } : null;
    s.nodes = cp.nodes;
    s.done = cp.done;
    return s;
  }

  static loadFromFile(problem: Problem, file: string): Solver {
    return Solver.fromCheckpoint(problem, JSON.parse(readFileSync(file, 'utf8')) as Checkpoint);
  }
}

/** 一次性求解：返回最优解（一定存在，因为可以全部不服务）。 */
export function solve(problem: Problem): Evaluated {
  const s = new Solver(problem);
  s.run();
  return s.getBest()!;
}
