/**
 * 交付库事件调度器。
 *
 * 规则:
 * 1. 候选事件 = 所有依赖均已交付、且自身未被取消、未被阻塞的事件。
 * 2. 候选之间按 (优先级高者优先, 优先级相同则 ID 小者优先) 排序交付。
 * 3. 优先级永远不能越过因果: 事件必须等其全部依赖交付后才可成为候选。
 * 4. 取消事件: 元数据保留在注册表中, 但该事件永不交付;
 *    其所有(传递)后继事件被阻塞, 并输出阻塞链。
 */

export interface DeliveryEvent {
  id: string;
  /** 数值越大优先级越高。 */
  priority: number;
  /** 必须先交付完成的事件 ID 列表。 */
  deps?: string[];
  /** 任意业务元数据; 取消后依然保留。 */
  metadata?: Record<string, unknown>;
}

export interface SatisfiedDep {
  depId: string;
  /** 该依赖在交付序列中的序号。 */
  deliveredAt: number;
}

/** 交付证书: 证明某事件在某一序号被交付, 且交付时其全部依赖已满足。 */
export interface DeliveryCertificate {
  /** 交付序号, 从 0 开始连续编号(逻辑时钟)。 */
  sequence: number;
  eventId: string;
  priority: number;
  satisfiedDeps: SatisfiedDep[];
  metadata: Record<string, unknown>;
}

export type BlockReason = "cancelled-dependency" | "dependency-cycle";

/** 阻塞链: 从根因(被取消的事件或依赖环)到被阻塞事件的一条路径。 */
export interface BlockingChain {
  rootCause: { kind: "cancelled" | "cycle"; eventIds: string[] };
  /** 从根因到被阻塞事件的事件 ID 路径(含两端)。 */
  path: string[];
}

export interface BlockedEvent {
  eventId: string;
  reason: BlockReason;
  chains: BlockingChain[];
  metadata: Record<string, unknown>;
}

export interface CancelledEvent {
  eventId: string;
  metadata: Record<string, unknown>;
}

export interface DeliveryPlan {
  /** 按交付顺序排列的交付证书。 */
  deliveries: DeliveryCertificate[];
  /** 被阻塞事件(按 ID 排序), 含阻塞链。 */
  blocked: BlockedEvent[];
  /** 被取消事件(按 ID 排序), 元数据保留。 */
  cancelled: CancelledEvent[];
}

/** 候选比较器: 优先级高者优先; 并列则 ID 小者优先(字典序)。 */
export function compareCandidates(
  a: { id: string; priority: number },
  b: { id: string; priority: number },
): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface IndexedEvent {
  id: string;
  priority: number;
  deps: string[];
  metadata: Record<string, unknown>;
}

function indexEvents(events: DeliveryEvent[]): Map<string, IndexedEvent> {
  const byId = new Map<string, IndexedEvent>();
  for (const ev of events) {
    if (byId.has(ev.id)) {
      throw new Error(`duplicate event id: ${ev.id}`);
    }
    byId.set(ev.id, {
      id: ev.id,
      priority: ev.priority,
      deps: ev.deps ? [...ev.deps] : [],
      metadata: ev.metadata ? { ...ev.metadata } : {},
    });
  }
  for (const ev of byId.values()) {
    for (const dep of ev.deps) {
      if (!byId.has(dep)) {
        throw new Error(`event ${ev.id} depends on unknown event: ${dep}`);
      }
    }
  }
  return byId;
}

/**  dependents 邻接表: dep -> 直接依赖它的事件列表。 */
function buildDependents(byId: Map<string, IndexedEvent>): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const id of byId.keys()) dependents.set(id, []);
  for (const ev of byId.values()) {
    for (const dep of ev.deps) {
      dependents.get(dep)!.push(ev.id);
    }
  }
  for (const list of dependents.values()) list.sort();
  return dependents;
}

/** 从根集合出发沿 dependents 边可达的全部节点(不含根自身)。 */
function reachableFrom(roots: Iterable<string>, dependents: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const next of dependents.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** 枚举从 root 到 target 的全部简单路径(沿 dependents 边)。 */
function enumeratePaths(
  root: string,
  target: string,
  dependents: Map<string, string[]>,
): string[][] {
  const paths: string[][] = [];
  const walk = (node: string, trail: string[], onTrail: Set<string>): void => {
    if (node === target) {
      paths.push([...trail]);
      return;
    }
    for (const next of dependents.get(node) ?? []) {
      if (!onTrail.has(next)) {
        onTrail.add(next);
        trail.push(next);
        walk(next, trail, onTrail);
        trail.pop();
        onTrail.delete(next);
      }
    }
  };
  walk(root, [root], new Set([root]));
  return paths;
}

/** 在子图 nodes 中找一个依赖环; 无环返回 null。 */
function findCycle(nodes: Set<string>, byId: Map<string, IndexedEvent>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodes) color.set(id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of byId.get(id)!.deps) {
      if (!nodes.has(dep)) continue;
      const c = color.get(dep)!;
      if (c === GRAY) {
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of [...nodes].sort()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

export function planDeliveries(
  events: DeliveryEvent[],
  cancelledIds: Iterable<string> = [],
): DeliveryPlan {
  const byId = indexEvents(events);
  const cancelled = new Set<string>();
  for (const id of cancelledIds) {
    if (!byId.has(id)) throw new Error(`cancelled event not found: ${id}`);
    cancelled.add(id);
  }
  const dependents = buildDependents(byId);

  // 1) 取消传播: 被取消事件的全部传递后继被阻塞(被取消者自身不算阻塞)。
  const tainted = reachableFrom(cancelled, dependents);
  for (const id of cancelled) tainted.delete(id);

  // 2) 剩余节点中检测依赖环: 环上及依赖环的节点永远无法交付。
  const remaining = new Set<string>();
  for (const id of byId.keys()) {
    if (!cancelled.has(id) && !tainted.has(id)) remaining.add(id);
  }
  const cycleBlocked = new Set<string>();
  const cycles: string[][] = [];
  for (;;) {
    const cycle = findCycle(remaining, byId);
    if (!cycle) break;
    cycles.push(cycle);
    for (const id of cycle) {
      remaining.delete(id);
      cycleBlocked.add(id);
    }
    // 依赖环上节点的节点同样无法交付。
    for (const id of reachableFrom(cycle, dependents)) {
      if (remaining.has(id)) {
        remaining.delete(id);
        cycleBlocked.add(id);
      }
    }
  }

  // 3) 贪心交付: 每步在候选中取 (优先级高, ID 小) 者。
  const deliveredAt = new Map<string, number>();
  const deliveries: DeliveryCertificate[] = [];
  const pending = new Set(remaining);
  while (pending.size > 0) {
    const ready: IndexedEvent[] = [];
    for (const id of pending) {
      const ev = byId.get(id)!;
      if (ev.deps.every((dep) => deliveredAt.has(dep))) ready.push(ev);
    }
    if (ready.length === 0) break; // 防御: 无环时不会发生
    ready.sort(compareCandidates);
    const next = ready[0]!;
    const sequence = deliveries.length;
    deliveries.push({
      sequence,
      eventId: next.id,
      priority: next.priority,
      satisfiedDeps: next.deps.map((depId) => ({
        depId,
        deliveredAt: deliveredAt.get(depId)!,
      })),
      metadata: { ...next.metadata },
    });
    deliveredAt.set(next.id, sequence);
    pending.delete(next.id);
  }

  // 4) 阻塞链。
  const blocked: BlockedEvent[] = [];
  for (const id of [...tainted].sort()) {
    const chains: BlockingChain[] = [];
    for (const root of [...cancelled].sort()) {
      for (const path of enumeratePaths(root, id, dependents)) {
        chains.push({ rootCause: { kind: "cancelled", eventIds: [root] }, path });
      }
    }
    chains.sort((x, y) => x.path.join("").localeCompare(y.path.join("")));
    blocked.push({
      eventId: id,
      reason: "cancelled-dependency",
      chains,
      metadata: { ...byId.get(id)!.metadata },
    });
  }
  for (const id of [...cycleBlocked].sort()) {
    const chains: BlockingChain[] = [];
    for (const cycle of cycles) {
      const inCycle = cycle.includes(id);
      const paths = inCycle
        ? [[...cycle]]
        : enumeratePaths(cycle[cycle.length - 2]!, id, dependents).map(
            (p) => [...cycle.slice(0, -1), ...p.slice(1)],
          );
      for (const path of paths) {
        chains.push({ rootCause: { kind: "cycle", eventIds: [...cycle] }, path });
      }
    }
    chains.sort((x, y) => x.path.join("").localeCompare(y.path.join("")));
    blocked.push({
      eventId: id,
      reason: "dependency-cycle",
      chains,
      metadata: { ...byId.get(id)!.metadata },
    });
  }
  blocked.sort((a, b) => (a.eventId < b.eventId ? -1 : 1));

  const cancelledOut: CancelledEvent[] = [...cancelled]
    .sort()
    .map((id) => ({ eventId: id, metadata: { ...byId.get(id)!.metadata } }));

  return { deliveries, blocked, cancelled: cancelledOut };
}
