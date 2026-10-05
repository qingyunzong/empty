import { CertStep, DeltaPackage, Problem, SolveResult } from "./types.js";

/**
 * 包 ID 序列字典序比较（按 UTF-16 码元序逐个比较；
 * 一方为另一方前缀时，短者更小）。
 */
export function compareSeq(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * 单条边是否满足空间限制。
 * 调度模型：即需即下载、应用后立即删除已消费包。
 * 该模型下第 i 步的峰值 = pkg.bytes（包文件）+ pkg.peak（应用暂存），
 * 提前下载只会增加占用，故此调度对任意固定序列都是峰值最优的。
 */
export function edgeFits(pkg: DeltaPackage, spaceLimit: number): boolean {
  return pkg.bytes + pkg.peak <= spaceLimit;
}

/** 由包序列生成逐步空间证书（即需即下载 + 用完即删）。 */
export function buildCertificate(
  sequence: DeltaPackage[],
  spaceLimit: number
): { steps: CertStep[]; maxPeak: number; ok: boolean } {
  let stored = 0;
  let maxPeak = 0;
  const steps: CertStep[] = sequence.map((pkg, i) => {
    const storedAfterDownload = stored + pkg.bytes;
    const peakDuringApply = storedAfterDownload + pkg.peak;
    const withinLimit = storedAfterDownload <= spaceLimit && peakDuringApply <= spaceLimit;
    maxPeak = Math.max(maxPeak, peakDuringApply);
    const step: CertStep = {
      index: i + 1,
      id: pkg.id,
      from: pkg.from,
      to: pkg.to,
      downloadBytes: pkg.bytes,
      storedAfterDownload,
      tempBytes: pkg.peak,
      peakDuringApply,
      storedAfterCleanup: stored, // 删除已消费包，占用回落到本步之前
      withinLimit,
    };
    return step;
  });
  return { steps, maxPeak, ok: steps.every((s) => s.withinLimit) };
}

interface Label {
  cost: number;
  seq: string[];
}

function compareLabel(a: Label, b: Label): number {
  if (a.cost !== b.cost) return a.cost - b.cost;
  return compareSeq(a.seq, b.seq);
}

class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly cmp: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cmp(items[i] as T, items[parent] as T) >= 0) break;
      [items[i], items[parent]] = [items[parent] as T, items[i] as T];
      i = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < items.length && this.cmp(items[l] as T, items[smallest] as T) < 0) smallest = l;
        if (r < items.length && this.cmp(items[r] as T, items[smallest] as T) < 0) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest] as T, items[i] as T];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * 求解：在仅含可行边（bytes+peak <= spaceLimit）的有向图上，
 * 找 start -> target 总下载量最小的路径；并列时取包 ID 序列字典序最小者。
 *
 * 由于 bytes >= 1，任何含环路径都可去环严格降低费用，故最优路径必为简单路径，
 * 且同一节点处“一序列为另一序列前缀”的并列不可能出现，Dijkstra 的
 * (cost, seq) 二元组标号满足最优子结构。
 */
export function solve(problem: Problem): SolveResult {
  const { start, target, spaceLimit } = problem;
  const excluded = problem.packages
    .filter((p) => !edgeFits(p, spaceLimit))
    .map((p) => ({ id: p.id, need: p.bytes + p.peak }));
  const edges = problem.packages.filter((p) => edgeFits(p, spaceLimit));

  const empty: SolveResult = {
    ok: false,
    sequence: [],
    totalBytes: 0,
    steps: [],
    maxPeak: 0,
    excluded,
  };

  if (start === target) {
    return { ...empty, ok: true };
  }

  const adj = new Map<string, DeltaPackage[]>();
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e);
    else adj.set(e.from, [e]);
  }

  const best = new Map<string, Label>();
  const heap = new MinHeap<{ node: string; label: Label }>((a, b) => compareLabel(a.label, b.label));
  const startLabel: Label = { cost: 0, seq: [] };
  best.set(start, startLabel);
  heap.push({ node: start, label: startLabel });

  while (heap.size > 0) {
    const { node, label } = heap.pop() as { node: string; label: Label };
    if (best.get(node) !== label) continue; // 过期堆项
    if (node === target) break;
    for (const e of adj.get(node) ?? []) {
      const next: Label = { cost: label.cost + e.bytes, seq: [...label.seq, e.id] };
      const cur = best.get(e.to);
      if (cur === undefined || compareLabel(next, cur) < 0) {
        best.set(e.to, next);
        heap.push({ node: e.to, label: next });
      }
    }
  }

  const finalLabel = best.get(target);
  if (finalLabel === undefined) {
    return {
      ...empty,
      reason:
        excluded.length > 0
          ? `不存在从 ${start} 到 ${target} 的可行路径（部分边因空间限制被排除）`
          : `不存在从 ${start} 到 ${target} 的可达路径`,
    };
  }

  const byId = new Map(problem.packages.map((p) => [p.id, p]));
  const chosen = finalLabel.seq.map((id) => byId.get(id) as DeltaPackage);
  const cert = buildCertificate(chosen, spaceLimit);
  return {
    ok: cert.ok,
    reason: cert.ok ? undefined : "空间证书校验失败",
    sequence: finalLabel.seq,
    totalBytes: finalLabel.cost,
    steps: cert.steps,
    maxPeak: cert.maxPeak,
    excluded,
  };
}

/** 两个包 ID 序列是否完全一致。 */
export function sameSeq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
