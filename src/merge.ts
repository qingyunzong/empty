/**
 * 三方合并：以 base 为共同祖先，合并左右两侧按节点 ID 记录的父指针变动。
 *
 * 两侧各自的移动都是合法的（各自不成环），但组合后可能成环。
 * 解环规则：取消环中优先级最低的边（操作优先级优先，节点 ID 决胜），
 * 并在 evidence 中记录完整证据。墓碑节点（删除）保留其子树。
 */
import { TreeState, NodeId, Parent, cloneTree, findCycle } from './tree.js';

export type Side = 'left' | 'right';

export interface MoveOp {
  kind: 'move';
  id: NodeId;
  newParent: Parent;
}

export interface DeleteOp {
  kind: 'delete';
  id: NodeId;
}

export type Op = MoveOp | DeleteOp;

/** 操作优先级：seq 为侧内序号（越大越新），side 用于跨侧决胜。 */
export interface Priority {
  seq: number;
  side: Side;
}

const SIDE_RANK: Record<Side, number> = { left: 0, right: 1 };

/** 比较两个操作优先级；返回值 >0 表示 a 更高。 */
export function comparePriority(a: Priority, b: Priority): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return SIDE_RANK[a.side] - SIDE_RANK[b.side];
}

/** 基底边的优先级：低于任何操作。 */
const BASE_PRIORITY: Priority = { seq: -1, side: 'left' };

export type EdgeSource = 'base' | Priority;

export interface CycleBreakEvidence {
  /** 第几轮解环（从 1 开始）。 */
  round: number;
  /** 环上节点，沿父指针顺序。 */
  cycle: NodeId[];
  /** 被取消的边。 */
  cancelledEdge: { child: NodeId; parent: Parent };
  /** 被取消边的来源（base 或产生它的操作优先级）。 */
  edgeSource: EdgeSource;
  /** 取消后 child 的新父节点（回退基底父指针；若回退无效则断开为 null）。 */
  revertedTo: Parent;
  reason: string;
}

export interface ConflictRecord {
  id: NodeId;
  winner: { side: Side; seq: number; parent: Parent };
  loser: { side: Side; seq: number; parent: Parent };
}

export interface MergeResult {
  tree: TreeState;
  /** 每次解环的证据。 */
  evidence: CycleBreakEvidence[];
  /** 同一节点被两侧同时移动时的裁决记录。 */
  conflicts: ConflictRecord[];
}

function sourceRank(src: EdgeSource): Priority {
  return src === 'base' ? BASE_PRIORITY : src;
}

/**
 * 三方合并入口。
 * leftOps / rightOps 为两侧操作序列，数组下标即侧内序号 seq。
 */
export function mergeTrees(base: TreeState, leftOps: Op[], rightOps: Op[]): MergeResult {
  // 1. 逐节点裁决父指针：同一节点两侧都移动时，优先级高者胜。
  const winner = new Map<NodeId, { parent: Parent; prio: Priority }>();
  const conflicts: ConflictRecord[] = [];

  const collect = (ops: Op[], side: Side): Map<NodeId, { parent: Parent; prio: Priority }> => {
    const perNode = new Map<NodeId, { parent: Parent; prio: Priority }>();
    ops.forEach((op, seq) => {
      if (op.kind !== 'move') return;
      const prio: Priority = { seq, side };
      const prev = perNode.get(op.id);
      if (!prev || comparePriority(prio, prev.prio) > 0) {
        perNode.set(op.id, { parent: op.newParent, prio });
      }
    });
    return perNode;
  };

  const leftMoves = collect(leftOps, 'left');
  const rightMoves = collect(rightOps, 'right');

  for (const [id, l] of leftMoves) {
    const r = rightMoves.get(id);
    if (!r) {
      winner.set(id, l);
    } else {
      const w = comparePriority(l.prio, r.prio) >= 0 ? l : r;
      const lo = w === l ? r : l;
      winner.set(id, w);
      conflicts.push({
        id,
        winner: { side: w.prio.side, seq: w.prio.seq, parent: w.parent },
        loser: { side: lo.prio.side, seq: lo.prio.seq, parent: lo.parent },
      });
    }
  }
  for (const [id, r] of rightMoves) {
    if (!leftMoves.has(id)) winner.set(id, r);
  }

  // 2. 墓碑：两侧删除取并集；墓碑节点及其子树保留在树中。
  const tree = cloneTree(base);
  for (const op of [...leftOps, ...rightOps]) {
    if (op.kind === 'delete') tree.tombstone.add(op.id);
  }

  // 3. 应用获胜的父指针，并记录每条边的来源。
  const edgeSource = new Map<NodeId, EdgeSource>();
  for (const id of tree.parent.keys()) edgeSource.set(id, 'base');
  for (const [id, w] of winner) {
    tree.parent.set(id, w.parent);
    edgeSource.set(id, w.prio);
  }

  // 4. 解环：每轮找出环中优先级最低的边（操作优先级 + 节点 ID 决胜）取消之。
  //    基底图本身无环，故每个环至少含一条操作边；每轮严格减少非常规边，必然终止。
  const evidence: CycleBreakEvidence[] = [];
  let round = 0;
  for (;;) {
    const cycle = findCycle(tree.parent);
    if (!cycle) break;
    round += 1;
    if (round > tree.parent.size + 1) {
      throw new Error('cycle breaking did not terminate');
    }

    // 环中边：child -> parent.get(child)
    let minChild: NodeId | null = null;
    let minPrio: Priority | null = null;
    for (const child of cycle) {
      const prio = sourceRank(edgeSource.get(child) ?? 'base');
      if (
        minChild === null ||
        comparePriority(prio, minPrio!) < 0 ||
        (comparePriority(prio, minPrio!) === 0 && child < minChild)
      ) {
        minChild = child;
        minPrio = prio;
      }
    }

    const child = minChild!;
    const parent = tree.parent.get(child) ?? null;
    const src = edgeSource.get(child) ?? 'base';
    const baseParent = base.parent.get(child) ?? null;
    // 优先回退到基底父指针；若该边本就是基底边（回退无效），则断开。
    const revertedTo: Parent = src !== 'base' && baseParent !== parent ? baseParent : null;
    tree.parent.set(child, revertedTo);
    edgeSource.set(child, 'base');

    evidence.push({
      round,
      cycle,
      cancelledEdge: { child, parent },
      edgeSource: src,
      revertedTo,
      reason:
        `cycle [${cycle.join(' -> ')}] broken by cancelling lowest-priority edge ` +
        `${child} -> ${String(parent)} (source: ${src === 'base' ? 'base' : `${src.side}#${src.seq}`}), ` +
        `reverted to ${String(revertedTo)}`,
    });
  }

  return { tree, evidence, conflicts };
}
