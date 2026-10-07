/**
 * DAG 关键路径调度器。
 *
 * - 正推计算每个节点的最早开始时间 ES，反推计算最晚开始时间 LS。
 * - 多个终点（汇点）视为连接到一个共同的零耗时虚拟出口 EXIT。
 * - 零时长边合法；权重必须是非负有限数。
 * - 修改边权后做增量更新（仅重算受影响的下游 ES 与上游 LS），
 *   并提供 verifyAgainstFullRecompute() 与全拓扑重算对照。
 * - 图中有环时 compute() 返回最短环。
 */

/** 虚拟共同出口（超级汇点）的节点 id。 */
export const EXIT = "__EXIT__";

export interface CriticalEdge {
  from: string;
  to: string;
  weight: number;
  /** true 表示指向虚拟出口 EXIT 的零耗时边。 */
  virtual: boolean;
}

/** 最长路径证书：一条从某个源点经关键边到虚拟出口的路径。 */
export interface LongestPathCertificate {
  /** 节点序列，以真实源点开始、以 EXIT 结束。 */
  nodes: string[];
  /** 与相邻节点对一一对应的边权（最后一条为到 EXIT 的 0）。 */
  weights: number[];
  /** 全部边权之和，等于项目总工期。 */
  totalDuration: number;
}

export interface ComputeOk {
  ok: true;
  /** 项目总工期（最长路径长度）。 */
  duration: number;
  earliestStart: ReadonlyMap<string, number>;
  latestStart: ReadonlyMap<string, number>;
  /** 全部关键边（含指向 EXIT 的虚拟零耗时边）。 */
  criticalEdges: CriticalEdge[];
  certificate: LongestPathCertificate;
}

export interface ComputeCycle {
  ok: false;
  /** 最短环：节点序列，首尾相同。 */
  cycle: string[];
}

export type ComputeResult = ComputeOk | ComputeCycle;

export class DagScheduler {
  private readonly nodeSet = new Set<string>();
  private readonly outAdj = new Map<string, Map<string, number>>();
  private readonly inAdj = new Map<string, Map<string, number>>();

  private topo: string[] = [];
  private readonly es = new Map<string, number>();
  private readonly ls = new Map<string, number>();
  /** 正推时取得最大值的 predecessor（用于回溯最长路径证书）。 */
  private readonly parent = new Map<string, string | null>();
  private duration = 0;
  private computed = false;

  addNode(id: string): void {
    if (id === EXIT) throw new Error(`节点 id 不能为保留名 ${EXIT}`);
    if (this.nodeSet.has(id)) return;
    this.nodeSet.add(id);
    this.outAdj.set(id, new Map());
    this.inAdj.set(id, new Map());
    this.computed = false;
  }

  addEdge(from: string, to: string, weight: number): void {
    this.checkWeight(weight);
    this.addNode(from);
    this.addNode(to);
    if (this.outAdj.get(from)!.has(to)) {
      throw new Error(`边 ${from} -> ${to} 已存在，请用 setWeight 修改`);
    }
    this.outAdj.get(from)!.set(to, weight);
    this.inAdj.get(to)!.set(from, weight);
    this.computed = false;
  }

  hasEdge(from: string, to: string): boolean {
    return this.outAdj.get(from)?.has(to) ?? false;
  }

  getWeight(from: string, to: string): number {
    const w = this.outAdj.get(from)?.get(to);
    if (w === undefined) throw new Error(`边 ${from} -> ${to} 不存在`);
    return w;
  }

  /** 修改工期（边权）。若已计算过，则做增量更新而非全量重算。 */
  setWeight(from: string, to: string, weight: number): void {
    this.checkWeight(weight);
    const adj = this.outAdj.get(from);
    if (!adj?.has(to)) throw new Error(`边 ${from} -> ${to} 不存在`);
    adj.set(to, weight);
    this.inAdj.get(to)!.set(from, weight);
    if (this.computed) this.incrementalUpdate(from, to);
  }

  /** 全拓扑重算。有环时返回最短环。 */
  compute(): ComputeResult {
    const cycle = this.findShortestCycle();
    if (cycle) {
      this.computed = false;
      return { ok: false, cycle };
    }
    this.topoSort();
    this.forwardPass();
    this.backwardPass();
    this.computed = true;
    return this.currentResult();
  }

  /** 当前计算结果（要求此前 compute() 成功且图无环）。 */
  currentResult(): ComputeOk {
    if (!this.computed) throw new Error("图尚未成功计算（可能有环），请先调用 compute()");
    return {
      ok: true,
      duration: this.duration,
      earliestStart: new Map(this.es),
      latestStart: new Map(this.ls),
      criticalEdges: this.collectCriticalEdges(),
      certificate: this.buildCertificate(),
    };
  }

  /**
   * 增量更新与全拓扑重算的对照：克隆当前图做全量 compute()，
   * 比较工期、ES/LS 与关键边集合是否完全一致。
   */
  verifyAgainstFullRecompute(): boolean {
    const clone = this.clone();
    const full = clone.compute();
    if (!this.computed) return !full.ok;
    if (!full.ok) return false;
    if (full.duration !== this.duration) return false;
    if (!mapsEqual(full.earliestStart, this.es)) return false;
    if (!mapsEqual(full.latestStart, this.ls)) return false;
    const key = (e: CriticalEdge) => `${e.from}->${e.to}:${e.weight}:${e.virtual}`;
    const a = this.collectCriticalEdges().map(key).sort();
    const b = full.criticalEdges.map(key).sort();
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  /** 校验最长路径证书：边真实存在、权重吻合、总和等于当前工期。 */
  verifyCertificate(cert: LongestPathCertificate): boolean {
    if (!this.computed) return false;
    const { nodes, weights } = cert;
    if (nodes.length < 2 || weights.length !== nodes.length - 1) return false;
    if (nodes[nodes.length - 1] !== EXIT) return false;
    const first = nodes[0]!;
    if ((this.inAdj.get(first)?.size ?? 1) !== 0) return false; // 必须始于源点
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      const a = nodes[i]!;
      const b = nodes[i + 1]!;
      const w = weights[i]!;
      if (b === EXIT) {
        if (i !== weights.length - 1) return false; // EXIT 只能是终点
        if (w !== 0) return false;
        if ((this.outAdj.get(a)?.size ?? 1) !== 0) return false; // 前驱必须是真实汇点
      } else {
        if (this.outAdj.get(a)?.get(b) !== w) return false;
      }
      sum += w;
    }
    return sum === cert.totalDuration && sum === this.duration;
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  private checkWeight(w: number): void {
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(`工期必须是非负有限数，得到 ${w}`);
    }
  }

  private clone(): DagScheduler {
    const g = new DagScheduler();
    for (const n of this.nodeSet) g.addNode(n);
    for (const [u, adj] of this.outAdj) {
      for (const [v, w] of adj) g.addEdge(u, v, w);
    }
    return g;
  }

  private topoSort(): void {
    const indeg = new Map<string, number>();
    for (const n of this.nodeSet) indeg.set(n, this.inAdj.get(n)!.size);
    const queue: string[] = [];
    for (const [n, d] of indeg) if (d === 0) queue.push(n);
    const order: string[] = [];
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      order.push(u);
      for (const v of this.outAdj.get(u)!.keys()) {
        const d = indeg.get(v)! - 1;
        indeg.set(v, d);
        if (d === 0) queue.push(v);
      }
    }
    if (order.length !== this.nodeSet.size) {
      throw new Error("图含环，无法拓扑排序");
    }
    this.topo = order;
  }

  private forwardPass(): void {
    this.es.clear();
    this.parent.clear();
    for (const u of this.topo) {
      let best = 0;
      let bestPred: string | null = null;
      for (const [p, w] of this.inAdj.get(u)!) {
        const cand = this.es.get(p)! + w;
        if (bestPred !== null ? cand > best : cand >= best) {
          best = cand;
          bestPred = p;
        }
      }
      this.es.set(u, best);
      this.parent.set(u, bestPred);
    }
    this.duration = 0;
    for (const v of this.es.values()) if (v > this.duration) this.duration = v;
  }

  private backwardPass(): void {
    this.ls.clear();
    for (let i = this.topo.length - 1; i >= 0; i--) {
      const u = this.topo[i]!;
      let best = this.duration; // 汇点：经零耗时虚拟边到 EXIT，LS = 总工期
      for (const [v, w] of this.outAdj.get(u)!) {
        const cand = this.ls.get(v)! - w;
        if (cand < best) best = cand;
      }
      this.ls.set(u, best);
    }
  }

  /**
   * 增量更新：边 from->to 的权重变化后，
   * 仅在拓扑序上重算 to 的下游 ES、以及 from 的上游 LS，值未变即停止扩散。
   */
  private incrementalUpdate(from: string, to: string): void {
    const oldDuration = this.duration;
    // 正推：重算 to 及其下游的 ES
    const dirty = new Set<string>([to]);
    for (const u of this.topo) {
      if (!dirty.has(u)) continue;
      let best = 0;
      let bestPred: string | null = null;
      for (const [p, w] of this.inAdj.get(u)!) {
        const cand = this.es.get(p)! + w;
        if (bestPred !== null ? cand > best : cand >= best) {
          best = cand;
          bestPred = p;
        }
      }
      this.parent.set(u, bestPred); // 父指针始终刷新，保证证书有效
      if (best !== this.es.get(u)) {
        this.es.set(u, best);
        for (const v of this.outAdj.get(u)!.keys()) dirty.add(v);
      }
    }
    // 总工期 = 汇点 ES 的最大值（权重非负，等于全局 ES 最大值）
    this.duration = 0;
    for (const v of this.es.values()) if (v > this.duration) this.duration = v;
    // 反推：重算 from 及其上游的 LS
    const dirtyBack = new Set<string>([from]);
    // 总工期变化时，汇点的 LS（恒等于总工期）随之改变，需一并作为传播源
    if (this.duration !== oldDuration) {
      for (const u of this.nodeSet) {
        if (this.outAdj.get(u)!.size === 0 && this.ls.get(u) !== this.duration) {
          dirtyBack.add(u);
        }
      }
    }
    for (let i = this.topo.length - 1; i >= 0; i--) {
      const u = this.topo[i]!;
      if (!dirtyBack.has(u)) continue;
      let best = this.duration;
      for (const [v, w] of this.outAdj.get(u)!) {
        const cand = this.ls.get(v)! - w;
        if (cand < best) best = cand;
      }
      if (best !== this.ls.get(u)) {
        this.ls.set(u, best);
        for (const p of this.inAdj.get(u)!.keys()) dirtyBack.add(p);
      }
    }
  }

  private collectCriticalEdges(): CriticalEdge[] {
    const result: CriticalEdge[] = [];
    for (const [u, adj] of this.outAdj) {
      for (const [v, w] of adj) {
        const eu = this.es.get(u)!;
        const lu = this.ls.get(u)!;
        const ev = this.es.get(v)!;
        const lv = this.ls.get(v)!;
        if (eu === lu && ev === lv && eu + w === ev) {
          result.push({ from: u, to: v, weight: w, virtual: false });
        }
      }
    }
    // 汇点到虚拟出口 EXIT 的零耗时边
    for (const u of this.nodeSet) {
      if (this.outAdj.get(u)!.size === 0) {
        const eu = this.es.get(u)!;
        const lu = this.ls.get(u)!;
        if (eu === lu && eu === this.duration) {
          result.push({ from: u, to: EXIT, weight: 0, virtual: true });
        }
      }
    }
    return result;
  }

  private buildCertificate(): LongestPathCertificate {
    if (this.nodeSet.size === 0) {
      return { nodes: [EXIT], weights: [], totalDuration: 0 };
    }
    // 找一个 ES 等于总工期的汇点作为路径终点
    let sink: string | null = null;
    for (const u of this.nodeSet) {
      if (this.outAdj.get(u)!.size === 0 && this.es.get(u) === this.duration) {
        sink = u;
        break;
      }
    }
    if (sink === null) throw new Error("内部错误：找不到达到总工期的汇点");
    const nodes: string[] = [];
    const weights: number[] = [];
    let cur: string | null = sink;
    while (cur !== null) {
      nodes.push(cur);
      const pred: string | null = this.parent.get(cur)!;
      if (pred !== null) weights.push(this.outAdj.get(pred)!.get(cur)!);
      cur = pred;
    }
    nodes.reverse();
    weights.reverse();
    nodes.push(EXIT);
    weights.push(0);
    return { nodes, weights, totalDuration: this.duration };
  }

  /**
   * 最短环检测：先 Kahn 判环，再对剩余子图中每个点 BFS，
   * 找回到起点的最短路径。返回首尾相同的节点序列，无环返回 null。
   */
  findShortestCycle(): string[] | null {
    const indeg = new Map<string, number>();
    for (const n of this.nodeSet) indeg.set(n, this.inAdj.get(n)!.size);
    const queue: string[] = [];
    for (const [n, d] of indeg) if (d === 0) queue.push(n);
    let processed = 0;
    for (let head = 0; head < queue.length; head++) {
      processed++;
      for (const v of this.outAdj.get(queue[head]!)!.keys()) {
        const d = indeg.get(v)! - 1;
        indeg.set(v, d);
        if (d === 0) queue.push(v);
      }
    }
    if (processed === this.nodeSet.size) return null;

    const remaining = new Set<string>();
    for (const [n, d] of indeg) if (d > 0) remaining.add(n);

    let best: string[] | null = null;
    for (const start of remaining) {
      const dist = new Map<string, number>([[start, 0]]);
      const prev = new Map<string, string>();
      const bfsQueue = [start];
      for (let head = 0; head < bfsQueue.length; head++) {
        const u = bfsQueue[head]!;
        const du = dist.get(u)!;
        if (best !== null && du + 1 >= best.length - 1) continue; // 剪枝
        for (const v of this.outAdj.get(u)!.keys()) {
          if (!remaining.has(v)) continue;
          if (v === start) {
            const len = du + 1; // 环的边数
            if (best === null || len < best.length - 1) {
              const path = [start];
              let cur = u;
              while (cur !== start) {
                path.push(cur);
                cur = prev.get(cur)!;
              }
              path.push(start);
              best = path;
            }
          } else if (!dist.has(v)) {
            dist.set(v, du + 1);
            prev.set(v, u);
            bfsQueue.push(v);
          }
        }
      }
    }
    return best;
  }
}

function mapsEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
