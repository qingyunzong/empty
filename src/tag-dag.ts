/**
 * 分类库 DAG 标签管理。
 *
 * - 标签为节点（按数值 ID），边 parent -> child 表示 parent 是 child 的上级分类。
 * - 支持批量改边（增/删），整批原子生效；任何会导致成环的批次整体拒绝。
 * - 支持查询两个标签的“所有最近公共祖先”（DAG 版 LCA）：
 *   共同祖先集合中，不存在另一个共同祖先是其严格后继（后代）的那些祖先。
 */

export type Edge = readonly [parent: number, child: number];

export interface EdgeChanges {
  readonly add?: readonly Edge[];
  readonly remove?: readonly Edge[];
}

export class TagDag {
  private readonly children = new Map<number, Set<number>>();
  private readonly parents = new Map<number, Set<number>>();

  /** 注册一个标签节点；重复注册为幂等操作。 */
  addTag(id: number): void {
    if (!this.children.has(id)) {
      this.children.set(id, new Set());
      this.parents.set(id, new Set());
    }
  }

  hasTag(id: number): boolean {
    return this.children.has(id);
  }

  /** 所有标签 ID，升序。 */
  tagIds(): number[] {
    return [...this.children.keys()].sort((a, b) => a - b);
  }

  /** 当前所有边 [parent, child]，按 parent、child 升序。 */
  edges(): Edge[] {
    const result: Edge[] = [];
    for (const [parent, kids] of this.children) {
      for (const child of kids) result.push([parent, child]);
    }
    return result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  hasEdge(parent: number, child: number): boolean {
    return this.children.get(parent)?.has(child) ?? false;
  }

  /** 单条加边，等价于只含该边的批次；成环则拒绝。 */
  addEdge(parent: number, child: number): void {
    this.applyEdgeChanges({ add: [[parent, child]] });
  }

  /** 单条删边。 */
  removeEdge(parent: number, child: number): void {
    this.applyEdgeChanges({ remove: [[parent, child]] });
  }

  /**
   * 批量改边：先删后加，整体校验后原子提交。
   * 若结果图含环（或任一改动非法），抛出错误且图保持原样。
   */
  applyEdgeChanges(changes: EdgeChanges): void {
    const removals = changes.remove ?? [];
    const additions = changes.add ?? [];

    const nextChildren = this.cloneAdjacency(this.children);
    const nextParents = this.cloneAdjacency(this.parents);

    for (const [parent, child] of removals) {
      this.requireTag(parent);
      this.requireTag(child);
      if (!nextChildren.get(parent)!.delete(child)) {
        throw new Error(`待删除的边不存在: ${parent} -> ${child}`);
      }
      nextParents.get(child)!.delete(parent);
    }

    for (const [parent, child] of additions) {
      this.requireTag(parent);
      this.requireTag(child);
      if (parent === child) {
        throw new Error(`不允许自环: ${parent} -> ${child}`);
      }
      const kids = nextChildren.get(parent)!;
      if (kids.has(child)) {
        throw new Error(`边已存在: ${parent} -> ${child}`);
      }
      kids.add(child);
      nextParents.get(child)!.add(parent);
    }

    const cycle = findCycle(nextChildren);
    if (cycle !== null) {
      throw new Error(`批量改边被拒绝：会产生环 ${cycle.join(" -> ")}`);
    }

    this.children.clear();
    this.parents.clear();
    for (const [id, kids] of nextChildren) this.children.set(id, kids);
    for (const [id, ps] of nextParents) this.parents.set(id, ps);
  }

  /** 严格祖先集合（不含自身）。 */
  ancestorsOf(id: number): Set<number> {
    this.requireTag(id);
    const result = new Set<number>();
    const stack = [...this.parents.get(id)!];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (result.has(node)) continue;
      result.add(node);
      for (const p of this.parents.get(node)!) stack.push(p);
    }
    return result;
  }

  /** 祖先集合（含自身），LCA 语义中“自身也是自己的祖先”。 */
  ancestorsOrSelf(id: number): Set<number> {
    const result = this.ancestorsOf(id);
    result.add(id);
    return result;
  }

  /**
   * 两个标签的所有最近公共祖先，按 ID 升序返回。
   *
   * 定义：c 是 a、b 的最近公共祖先，当且仅当
   *  1. c 同时是 a、b 的祖先（含自身，即 a 是 b 的祖先时 a 也算）；
   *  2. 不存在另一个共同祖先 c' 是 c 的严格后代（即没有“更近的共同后继者”）。
   */
  lowestCommonAncestors(a: number, b: number): number[] {
    const ancestorsA = this.ancestorsOrSelf(a);
    const ancestorsB = this.ancestorsOrSelf(b);

    const common = new Set<number>();
    for (const id of ancestorsA) {
      if (ancestorsB.has(id)) common.add(id);
    }

    // 若 c 是某个共同祖先 c' 的严格祖先，则 c' 是更近的共同后继者，c 被淘汰。
    const dominated = new Set<number>();
    for (const c of common) {
      for (const anc of this.ancestorsOf(c)) dominated.add(anc);
    }

    return [...common].filter((c) => !dominated.has(c)).sort((x, y) => x - y);
  }

  private requireTag(id: number): void {
    if (!this.children.has(id)) {
      throw new Error(`标签不存在: ${id}`);
    }
  }

  private cloneAdjacency(source: Map<number, Set<number>>): Map<number, Set<number>> {
    const copy = new Map<number, Set<number>>();
    for (const [id, set] of source) copy.set(id, new Set(set));
    return copy;
  }
}

/** Kahn 拓扑排序检测环；有环时返回环上节点序列（首尾相接），无环返回 null。 */
function findCycle(children: Map<number, Set<number>>): number[] | null {
  const indegree = new Map<number, number>();
  for (const id of children.keys()) indegree.set(id, 0);
  for (const kids of children.values()) {
    for (const child of kids) indegree.set(child, indegree.get(child)! + 1);
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.pop()!;
    visited += 1;
    for (const child of children.get(node)!) {
      const d = indegree.get(child)! - 1;
      indegree.set(child, d);
      if (d === 0) queue.push(child);
    }
  }
  if (visited === children.size) return null;

  // 提取环上节点：剩余入度 > 0 的节点中沿边走一圈。
  const inCycle = new Set(
    [...indegree.entries()].filter(([, d]) => d > 0).map(([id]) => id),
  );
  const start = inCycle.values().next().value!;
  const path = [start];
  let current = start;
  for (;;) {
    const next = [...children.get(current)!].find((c) => inCycle.has(c))!;
    if (next === start) break;
    path.push(next);
    current = next;
  }
  path.push(start);
  return path;
}
