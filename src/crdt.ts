/**
 * RGA-style replicated text CRDT.
 *
 * - Every character has a globally unique id "<replicaId>:<counter>".
 * - Every insert references its predecessor id (ROOT for the head).
 * - Concurrent inserts at the same position are ordered by id (greater id first).
 * - Deletes leave tombstones; nodes are never removed from the tree.
 * - Ops whose predecessor/target is unknown are buffered and NEVER
 *   re-attached to the root; they apply only when their dependency arrives.
 * - Malicious dependency cycles (e.g. A.pred=B, B.pred=A, or self-loops)
 *   are detected and quarantined instead of corrupting the tree.
 */

export type CharId = string;

export const ROOT: CharId = "ROOT";

export interface InsertOp {
  type: "insert";
  id: CharId;
  predId: CharId;
  value: string;
}

export interface DeleteOp {
  type: "delete";
  id: CharId;
}

export type Op = InsertOp | DeleteOp;

export interface RejectedOp {
  op: Op;
  reason: string;
}

interface Node {
  id: CharId;
  predId: CharId;
  value: string;
  tombstone: boolean;
  children: Node[];
}

/** Parse "<replicaId>:<counter>"; falls back to (id, 0) semantics for ROOT. */
export function compareIds(a: CharId, b: CharId): number {
  if (a === b) return 0;
  const pa = a.lastIndexOf(":");
  const pb = b.lastIndexOf(":");
  const ca = pa >= 0 ? Number(a.slice(pa + 1)) : NaN;
  const cb = pb >= 0 ? Number(b.slice(pb + 1)) : NaN;
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
  return a < b ? -1 : 1;
}

export class Replica {
  readonly replicaId: string;
  private counter = 0;
  private readonly root: Node = {
    id: ROOT,
    predId: "",
    value: "",
    tombstone: true,
    children: [],
  };
  private readonly nodes = new Map<CharId, Node>([[ROOT, this.root]]);
  /** Inserts waiting for their predecessor id; deletes waiting for their target id. */
  private readonly pending = new Map<CharId, Op[]>();
  readonly rejected: RejectedOp[] = [];

  constructor(replicaId: string) {
    this.replicaId = replicaId;
  }

  private nextId(): CharId {
    return `${this.replicaId}:${++this.counter}`;
  }

  /** Id of the last visible character, or ROOT when the document is empty. */
  private lastVisibleId(): CharId {
    let last: CharId = ROOT;
    this.walk((n) => {
      if (!n.tombstone) last = n.id;
    });
    return last;
  }

  /** Local append insert; returns the op to broadcast. */
  localInsert(value: string, predId?: CharId): InsertOp {
    const op: InsertOp = {
      type: "insert",
      id: this.nextId(),
      predId: predId ?? this.lastVisibleId(),
      value,
    };
    this.apply(op);
    return op;
  }

  /** Local delete; returns the op to broadcast. */
  localDelete(id: CharId): DeleteOp {
    const op: DeleteOp = { type: "delete", id };
    this.apply(op);
    return op;
  }

  /** Apply a (local or remote) op. Idempotent and order-tolerant. */
  apply(op: Op): void {
    if (op.type === "insert") this.applyInsert(op);
    else this.applyDelete(op);
  }

  private buffer(key: CharId, op: Op): void {
    const list = this.pending.get(key);
    if (list) list.push(op);
    else this.pending.set(key, [op]);
  }

  private applyInsert(op: InsertOp): void {
    if (this.nodes.has(op.id)) return; // duplicate delivery
    if (op.id === ROOT) {
      this.rejected.push({ op, reason: "id collides with ROOT" });
      return;
    }
    if (op.predId === op.id) {
      this.rejected.push({ op, reason: "self-dependency cycle" });
      return;
    }
    const parent = this.nodes.get(op.predId);
    if (!parent) {
      // Predecessor not here yet: buffer. Never re-attach to root.
      this.buffer(op.predId, op);
      return;
    }
    const node: Node = {
      id: op.id,
      predId: op.predId,
      value: op.value,
      tombstone: false,
      children: [],
    };
    // Children sorted by id descending: greater id wins the position.
    let i = 0;
    while (i < parent.children.length && compareIds(parent.children[i]!.id, node.id) > 0) i++;
    parent.children.splice(i, 0, node);
    this.nodes.set(node.id, node);
    this.flush(node.id);
  }

  private applyDelete(op: DeleteOp): void {
    const node = this.nodes.get(op.id);
    if (!node) {
      this.buffer(op.id, op); // target not here yet
      return;
    }
    node.tombstone = true; // idempotent; tombstone stays in the tree
  }

  /** Flush ops that were waiting on `id`. */
  private flush(id: CharId): void {
    const list = this.pending.get(id);
    if (!list) return;
    this.pending.delete(id);
    for (const op of list) this.apply(op);
  }

  private walk(fn: (n: Node) => void): void {
    const stack: Node[] = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      fn(n);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }

  /** Visible text projection (tombstones skipped, kept in the tree). */
  text(): string {
    let out = "";
    this.walk((n) => {
      if (n !== this.root && !n.tombstone) out += n.value;
    });
    return out;
  }

  /** Total nodes including tombstones (proves deletes keep tombstones). */
  size(): number {
    return this.nodes.size - 1; // exclude ROOT sentinel
  }

  pendingCount(): number {
    let n = 0;
    for (const list of this.pending.values()) n += list.length;
    return n;
  }

  /**
   * Detect malicious dependency cycles among buffered inserts.
   * A cycle can never resolve (each member waits on another member),
   * so every insert in the cycle is quarantined and reported.
   * Returns the ids found in cycles.
   */
  detectCycles(): CharId[] {
    const pendingInserts = new Map<CharId, InsertOp>();
    for (const list of this.pending.values()) {
      for (const op of list) if (op.type === "insert") pendingInserts.set(op.id, op);
    }
    const cyclic = new Set<CharId>();
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<CharId, number>();
    const visit = (id: CharId, trail: CharId[]): void => {
      color.set(id, GRAY);
      trail.push(id);
      const op = pendingInserts.get(id)!;
      const next = op.predId;
      if (pendingInserts.has(next)) {
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          const start = trail.indexOf(next);
          for (const m of trail.slice(start)) cyclic.add(m);
        } else if (c === WHITE) {
          visit(next, trail);
        }
      }
      trail.pop();
      color.set(id, BLACK);
    };
    for (const id of pendingInserts.keys()) {
      if ((color.get(id) ?? WHITE) === WHITE) visit(id, []);
    }
    for (const id of cyclic) {
      const op = pendingInserts.get(id)!;
      this.rejected.push({ op, reason: "dependency cycle" });
      const list = this.pending.get(op.predId);
      if (list) {
        const idx = list.indexOf(op);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.pending.delete(op.predId);
      }
    }
    return [...cyclic];
  }
}

/**
 * Reference projection: rebuild a tree from the full event log in a
 * canonical order (sorted by id, dependency passes until fixpoint).
 * Used to cross-check an incrementally-built replica for convergence.
 */
export function buildFromEventLog(events: readonly Op[]): {
  text: string;
  size: number;
  unresolved: Op[];
} {
  const replica = new Replica("verifier");
  const sorted = [...events].sort((a, b) => compareIds(opKey(a), opKey(b)));
  let remaining = sorted;
  for (;;) {
    const before = remaining.length;
    const stillPending: Op[] = [];
    for (const op of remaining) {
      const pendBefore = replica.pendingCount();
      const rejBefore = replica.rejected.length;
      replica.apply(op);
      if (replica.pendingCount() > pendBefore && replica.rejected.length === rejBefore) {
        stillPending.push(op); // dependency still missing
      }
    }
    remaining = stillPending;
    if (remaining.length === before) break; // fixpoint: rest are cyclic/unresolvable
  }
  return { text: replica.text(), size: replica.size(), unresolved: remaining };
}

function opKey(op: Op): CharId {
  return op.type === "insert" ? op.id : op.id;
}
