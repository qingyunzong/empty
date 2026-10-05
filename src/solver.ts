import { Plan, PlanStep, Problem, Plugin } from "./types";

export const MAX_PLUGINS = 18;
const MAX_CAPABILITIES = 29; // 状态空间为 2^caps，number 位掩码安全上限

export function validateProblem(problem: Problem): void {
  if (problem.plugins.length > MAX_PLUGINS) {
    throw new Error(`too many plugins: ${problem.plugins.length} > ${MAX_PLUGINS}`);
  }
  const ids = new Set<string>();
  for (const p of problem.plugins) {
    if (ids.has(p.id)) throw new Error(`duplicate plugin id: ${p.id}`);
    ids.add(p.id);
    if (!Number.isInteger(p.cost) || p.cost < 0) {
      throw new Error(`plugin ${p.id}: cost must be a non-negative integer`);
    }
    if (p.provides.length === 0) {
      throw new Error(`plugin ${p.id}: provides must be non-empty`);
    }
  }
}

export interface Compiled {
  caps: string[];
  initialMask: number;
  targetMask: number;
  requiresMask: number[];
  providesMask: number[];
}

export function compileProblem(problem: Problem): Compiled {
  const index = new Map<string, number>();
  const caps: string[] = [];
  const bit = (cap: string): number => {
    let i = index.get(cap);
    if (i === undefined) {
      i = caps.length;
      if (i >= MAX_CAPABILITIES) {
        throw new Error(`too many distinct capabilities: > ${MAX_CAPABILITIES}`);
      }
      index.set(cap, i);
      caps.push(cap);
    }
    return 1 << i;
  };
  const maskOf = (list: string[]): number => list.reduce((m, c) => m | bit(c), 0);
  const initialMask = maskOf(problem.initial);
  const targetMask = maskOf(problem.target);
  const requiresMask = problem.plugins.map((p) => maskOf(p.requires));
  const providesMask = problem.plugins.map((p) => maskOf(p.provides));
  return { caps, initialMask, targetMask, requiresMask, providesMask };
}

export function maskToCaps(compiled: Compiled, mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < compiled.caps.length; i++) {
    if (mask & (1 << i)) out.push(compiled.caps[i] as string);
  }
  return out;
}

// 二叉最小堆，元素为 [cost, state]。
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.keys[parent] as number) <= (this.keys[i] as number)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): [number, number] {
    const topKey = this.keys[0] as number;
    const topVal = this.vals[0] as number;
    const lastKey = this.keys.pop() as number;
    const lastVal = this.vals.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && (this.keys[l] as number) < (this.keys[smallest] as number)) smallest = l;
        if (r < this.keys.length && (this.keys[r] as number) < (this.keys[smallest] as number)) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return [topKey, topVal];
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a] as number;
    this.keys[a] = this.keys[b] as number;
    this.keys[b] = k;
    const v = this.vals[a] as number;
    this.vals[a] = this.vals[b] as number;
    this.vals[b] = v;
  }
}

// 在"已具能力集合"状态空间上跑 Dijkstra（等代价搜索）。
// 状态 = 能力位掩码；边 = 启用一个 requires 已被满足的插件。
// 能力只增不减、插件成本非负，故该状态图上的最短路即真实最优解。
// 顺序语义天然排除循环自供：插件的 requires 必须在启用前已被其它来源满足。
export function solve(problem: Problem): Plan | null {
  validateProblem(problem);
  const c = compileProblem(problem);
  const { plugins } = problem;
  const size = 1 << c.caps.length;
  const dist = new Array<number>(size).fill(Infinity);
  const prevState = new Int32Array(size).fill(-1);
  const prevPlugin = new Int32Array(size).fill(-1);
  const heap = new MinHeap();
  dist[c.initialMask] = 0;
  heap.push(0, c.initialMask);

  let goalState = -1;
  while (heap.size > 0) {
    const [d, s] = heap.pop();
    if (d > (dist[s] as number)) continue; // 过期堆项
    if ((s & c.targetMask) === c.targetMask) {
      goalState = s;
      break;
    }
    for (let i = 0; i < plugins.length; i++) {
      const req = c.requiresMask[i] as number;
      if ((s & req) !== req) continue; // 前置能力未满足（含自供/循环情形）
      const prov = c.providesMask[i] as number;
      const ns = s | prov;
      if (ns === s) continue; // 不提供新能力，启用无意义
      const nd = d + (plugins[i] as Plugin).cost;
      if (nd < (dist[ns] as number)) {
        dist[ns] = nd;
        prevState[ns] = s;
        prevPlugin[ns] = i;
        heap.push(nd, ns);
      }
    }
  }

  if (goalState < 0) return null;

  const pluginSeq: Plugin[] = [];
  const stateSeq: number[] = [];
  for (let s = goalState; s !== c.initialMask; s = prevState[s] as number) {
    pluginSeq.push(plugins[prevPlugin[s] as number] as Plugin);
    stateSeq.push(s);
  }
  pluginSeq.reverse();
  stateSeq.reverse();

  const steps: PlanStep[] = pluginSeq.map((plugin, i) => ({
    plugin,
    heldAfter: maskToCaps(c, stateSeq[i] as number),
  }));
  return { initial: maskToCaps(c, c.initialMask), steps, totalCost: dist[goalState] as number };
}
