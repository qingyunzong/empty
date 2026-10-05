/** 协作树基础结构：节点以 ID 标识，父指针构成森林（约定单一根）。 */

export type NodeId = string;
export type Parent = NodeId | null;

export interface TreeState {
  /** 每个节点至多一个父节点；null 表示根/游离节点。 */
  parent: Map<NodeId, Parent>;
  /** 墓碑节点：已删除但保留其子树，不参与父指针合并冲突。 */
  tombstone: Set<NodeId>;
}

export function cloneTree(tree: TreeState): TreeState {
  return {
    parent: new Map(tree.parent),
    tombstone: new Set(tree.tombstone),
  };
}

/**
 * 在父指针函数图中查找一个环。
 * 每个节点出度至多为 1，因此用三色标记即可在线性时间内定位环。
 * 返回环上节点（沿父指针顺序），无环返回 null。
 */
export function findCycle(parent: ReadonlyMap<NodeId, Parent>): NodeId[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<NodeId, number>();
  for (const id of parent.keys()) color.set(id, WHITE);

  for (const start of parent.keys()) {
    if (color.get(start) !== WHITE) continue;
    const path: NodeId[] = [];
    let cur: NodeId | null = start;
    while (cur !== null && parent.has(cur) && color.get(cur) === WHITE) {
      color.set(cur, GRAY);
      path.push(cur);
      cur = parent.get(cur) ?? null;
    }
    if (cur !== null && color.get(cur) === GRAY) {
      const idx = path.indexOf(cur);
      return path.slice(idx);
    }
    for (const id of path) color.set(id, BLACK);
  }
  return null;
}

/** 从 node 沿父指针可达祖先集合（含自身），用于单侧移动合法性校验。 */
export function ancestorsOf(parent: ReadonlyMap<NodeId, Parent>, node: NodeId): Set<NodeId> {
  const seen = new Set<NodeId>();
  let cur: NodeId | null = node;
  while (cur !== null && parent.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = parent.get(cur) ?? null;
  }
  return seen;
}

/** 判断把 child 挂到 newParent 下是否会成环（newParent 是 child 的祖先或自身则成环）。 */
export function wouldCycle(parent: ReadonlyMap<NodeId, Parent>, child: NodeId, newParent: Parent): boolean {
  if (newParent === null) return false;
  if (newParent === child) return true;
  return ancestorsOf(parent, newParent).has(child);
}
