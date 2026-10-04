/**
 * RGA-style replicated text buffer.
 *
 * - Every character carries a unique id and the id of its predecessor.
 * - Concurrent inserts at the same position are ordered deterministically
 *   by character id (descending), so all replicas converge.
 * - Deletes only flip a tombstone flag; the node stays in the tree so that
 *   later inserts may still reference it as a predecessor.
 * - An insert whose predecessor has not arrived yet is buffered. It is
 *   NEVER re-attached to the root; it waits until its real predecessor
 *   shows up.
 * - Buffered inserts that form a dependency cycle (a.pred = b, b.pred = a,
 *   or self-loops) are detected and rejected as malicious.
 */

export const ROOT = "ROOT";

export interface InsertMsg {
  kind: "insert";
  id: string;
  pred: string;
  value: string;
}

export interface DeleteMsg {
  kind: "delete";
  /** id of the character to tombstone */
  id: string;
}

export type Message = InsertMsg | DeleteMsg;

export type ApplyStatus =
  | "applied"
  | "duplicate"
  | "buffered"
  | "rejected-cycle"
  | "rejected";

interface CharNode {
  id: string;
  pred: string;
  value: string;
  deleted: boolean;
}

/** Globally unique, lexicographically sortable character id. */
export function makeId(site: string, seq: number): string {
  return `${site}@${String(seq).padStart(6, "0")}`;
}

export function insert(id: string, pred: string, value: string): InsertMsg {
  return { kind: "insert", id, pred, value };
}

export function del(id: string): DeleteMsg {
  return { kind: "delete", id };
}

export class CrdtDocument {
  private nodes = new Map<string, CharNode>();
  /** parent id -> child ids, sorted by id descending */
  private children = new Map<string, string[]>();
  /** buffered inserts keyed by their own id */
  private pending = new Map<string, InsertMsg>();
  /** missing predecessor id -> ids of inserts waiting for it */
  private waiters = new Map<string, Set<string>>();
  /** deletes waiting for their target character to arrive */
  private pendingDeletes = new Set<string>();
  /** rejected char id -> reason */
  private rejectedIds = new Map<string, string>();

  apply(msg: Message): ApplyStatus {
    return msg.kind === "insert" ? this.applyInsert(msg) : this.applyDelete(msg);
  }

  private applyInsert(msg: InsertMsg): ApplyStatus {
    if (this.nodes.has(msg.id) || this.pending.has(msg.id)) return "duplicate";
    if (this.rejectedIds.has(msg.id)) return "rejected";

    if (msg.pred !== ROOT && !this.nodes.has(msg.pred)) {
      // Predecessor unknown: buffer. Never re-attach to ROOT.
      this.pending.set(msg.id, msg);
      let set = this.waiters.get(msg.pred);
      if (!set) this.waiters.set(msg.pred, (set = new Set()));
      set.add(msg.id);

      const cycle = this.findCycle(msg.id);
      if (cycle) {
        for (const id of cycle) this.reject(id, "dependency-cycle");
        return "rejected-cycle";
      }
      return "buffered";
    }

    this.attach(msg);
    return "applied";
  }

  private applyDelete(msg: DeleteMsg): ApplyStatus {
    const node = this.nodes.get(msg.id);
    if (node) {
      if (node.deleted) return "duplicate";
      node.deleted = true; // tombstone: node stays in the tree
      return "applied";
    }
    if (this.rejectedIds.has(msg.id)) return "rejected";
    if (this.pendingDeletes.has(msg.id)) return "duplicate";
    this.pendingDeletes.add(msg.id); // target not here yet: buffer
    return "buffered";
  }

  private attach(msg: InsertMsg): void {
    this.nodes.set(msg.id, {
      id: msg.id,
      pred: msg.pred,
      value: msg.value,
      deleted: false,
    });

    const sibs = this.children.get(msg.pred) ?? [];
    // keep siblings sorted by id descending: deterministic order for
    // concurrent inserts at the same position
    let i = 0;
    while (i < sibs.length) {
      const cur = sibs[i];
      if (cur === undefined || cur <= msg.id) break;
      i++;
    }
    sibs.splice(i, 0, msg.id);
    this.children.set(msg.pred, sibs);

    // a delete for this char may have arrived before the char itself
    if (this.pendingDeletes.delete(msg.id)) {
      const node = this.nodes.get(msg.id);
      if (node) node.deleted = true;
    }

    // flush inserts that were waiting for this id as their predecessor
    const waiting = this.waiters.get(msg.id);
    if (waiting) {
      this.waiters.delete(msg.id);
      for (const id of waiting) {
        const m = this.pending.get(id);
        if (m) {
          this.pending.delete(id);
          this.attach(m);
        }
      }
    }
  }

  /**
   * Walk the predecessor chain through the buffer starting at `startId`.
   * Returns the ids forming a cycle, or null if the chain ends at an
   * attached node or at a still-missing (but cycle-free) predecessor.
   */
  private findCycle(startId: string): string[] | null {
    const chain: string[] = [];
    const pos = new Map<string, number>();
    let cur = this.pending.get(startId);
    while (cur) {
      const seenAt = pos.get(cur.id);
      if (seenAt !== undefined) return chain.slice(seenAt);
      pos.set(cur.id, chain.length);
      chain.push(cur.id);
      cur = this.pending.get(cur.pred);
    }
    return null;
  }

  private reject(id: string, reason: string): void {
    const msg = this.pending.get(id);
    this.pending.delete(id);
    if (msg) {
      const set = this.waiters.get(msg.pred);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.waiters.delete(msg.pred);
      }
    }
    this.rejectedIds.set(id, reason);
  }

  /** Visible text: pre-order walk of the tree, skipping tombstones. */
  projection(): string {
    let out = "";
    const walk = (parent: string): void => {
      for (const id of this.children.get(parent) ?? []) {
        const node = this.nodes.get(id);
        if (!node) continue;
        if (!node.deleted) out += node.value;
        walk(id);
      }
    };
    walk(ROOT);
    return out;
  }

  /** total characters in the tree, tombstones included */
  get size(): number {
    return this.nodes.size;
  }

  get tombstoneCount(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.deleted) n++;
    return n;
  }

  get bufferedCount(): number {
    return this.pending.size;
  }

  isBuffered(id: string): boolean {
    return this.pending.has(id);
  }

  isRejected(id: string): boolean {
    return this.rejectedIds.has(id);
  }

  isDeleted(id: string): boolean {
    return this.nodes.get(id)?.deleted ?? false;
  }
}
