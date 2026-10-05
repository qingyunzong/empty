import { computeDigest } from "./digest.js";

/** A single versioned delta received over the subscription. */
export interface Delta {
  /** Unique version id. */
  readonly id: string;
  /** Declared parent version ids. Empty = root. >1 = merge. */
  readonly parents: readonly string[];
  /** Opaque version content. */
  readonly payload: unknown;
  /** Claimed sha256 digest of canonical({id, parents, payload}). */
  readonly digest: string;
}

export type ApplyStatus =
  | "applied"
  | "buffered"
  | "duplicate"
  | "bad-digest"
  | "quarantined";

export interface ApplyResult {
  readonly id: string;
  readonly status: ApplyStatus;
  /** Parent ids that were missing when the delta was buffered. */
  readonly missingParents: readonly string[];
}

interface Node {
  readonly delta: Delta;
  readonly children: string[];
}

/**
 * Version graph for a subscription merge pipeline.
 *
 * - Deltas declare parents; deltas with missing parents are buffered and
 *   promoted once every parent has been applied (out-of-order safe).
 * - Branches are never force-linearized: the graph keeps every head and
 *   queries must name an explicit branch head.
 * - A delta whose digest does not match its content is quarantined together
 *   with all of its successors (present and future).
 */
export class VersionGraph {
  readonly #nodes = new Map<string, Node>();
  readonly #pending = new Map<string, Delta>();
  readonly #pendingMissing = new Map<string, Set<string>>();
  readonly #waitingOn = new Map<string, Set<string>>();
  readonly #bad = new Set<string>();

  /** Feed one delta in arrival order. */
  apply(delta: Delta): ApplyResult {
    const { id } = delta;
    if (this.#nodes.has(id) || this.#pending.has(id) || this.#bad.has(id)) {
      return { id, status: "duplicate", missingParents: [] };
    }
    if (computeDigest(id, delta.parents, delta.payload) !== delta.digest) {
      this.#quarantine(id);
      return { id, status: "bad-digest", missingParents: [] };
    }
    if (delta.parents.some((parent) => this.#bad.has(parent))) {
      this.#quarantine(id);
      return { id, status: "quarantined", missingParents: [] };
    }
    const missing = delta.parents.filter((parent) => !this.#nodes.has(parent));
    if (missing.length > 0) {
      this.#pending.set(id, delta);
      this.#pendingMissing.set(id, new Set(missing));
      for (const parent of missing) {
        let waiters = this.#waitingOn.get(parent);
        if (waiters === undefined) {
          waiters = new Set();
          this.#waitingOn.set(parent, waiters);
        }
        waiters.add(id);
      }
      return { id, status: "buffered", missingParents: missing };
    }
    this.#attach(delta);
    return { id, status: "applied", missingParents: [] };
  }

  #attach(delta: Delta): void {
    const node: Node = { delta, children: [] };
    this.#nodes.set(delta.id, node);
    for (const parent of delta.parents) {
      this.#nodes.get(parent)?.children.push(delta.id);
    }
    const waiters = this.#waitingOn.get(delta.id);
    if (waiters === undefined) return;
    this.#waitingOn.delete(delta.id);
    for (const waiterId of waiters) {
      const missing = this.#pendingMissing.get(waiterId);
      missing?.delete(delta.id);
      if (missing !== undefined && missing.size === 0) {
        const promoted = this.#pending.get(waiterId);
        this.#pending.delete(waiterId);
        this.#pendingMissing.delete(waiterId);
        if (promoted !== undefined) this.#attach(promoted);
      }
    }
  }

  #quarantine(id: string): void {
    if (this.#bad.has(id)) return;
    this.#bad.add(id);
    const waiters = this.#waitingOn.get(id);
    if (waiters === undefined) return;
    this.#waitingOn.delete(id);
    for (const waiterId of waiters) {
      this.#pending.delete(waiterId);
      this.#pendingMissing.delete(waiterId);
      this.#quarantine(waiterId);
    }
  }

  has(id: string): boolean {
    return this.#nodes.has(id);
  }

  isQuarantined(id: string): boolean {
    return this.#bad.has(id);
  }

  appliedIds(): string[] {
    return [...this.#nodes.keys()].sort();
  }

  pendingIds(): string[] {
    return [...this.#pending.keys()].sort();
  }

  quarantinedIds(): string[] {
    return [...this.#bad].sort();
  }

  /** Current branch heads: applied versions with no applied children. */
  heads(): string[] {
    const result: string[] = [];
    for (const [id, node] of this.#nodes) {
      if (node.children.length === 0) result.push(id);
    }
    return result.sort();
  }

  /**
   * Query one branch. The head is mandatory: the graph never picks a
   * "main" line for you. Returns the ancestor deltas of `head` in
   * topological order (parents always before their children).
   */
  history(head: string): Delta[] {
    if (head === undefined || head === null || head === "") {
      throw new Error("query requires an explicit branch head");
    }
    if (this.#bad.has(head)) {
      throw new Error(`head ${head} is quarantined (bad digest in ancestry)`);
    }
    if (!this.#nodes.has(head)) {
      throw new Error(`unknown head: ${head}`);
    }
    const ordered: Delta[] = [];
    const visited = new Set<string>();
    const stack: Array<{ id: string; leaving: boolean }> = [
      { id: head, leaving: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.leaving) {
        ordered.push(this.#nodes.get(frame.id)!.delta);
        continue;
      }
      if (visited.has(frame.id)) continue;
      visited.add(frame.id);
      stack.push({ id: frame.id, leaving: true });
      const parents = this.#nodes.get(frame.id)!.delta.parents;
      for (let index = parents.length - 1; index >= 0; index -= 1) {
        const parent = parents[index]!;
        if (!visited.has(parent)) {
          stack.push({ id: parent, leaving: false });
        }
      }
    }
    return ordered;
  }

  /** Fold the payloads along one branch into a materialized state. */
  materialize<T>(
    head: string,
    initial: T,
    reduce: (state: T, payload: unknown, delta: Delta) => T,
  ): T {
    let state = initial;
    for (const delta of this.history(head)) {
      state = reduce(state, delta.payload, delta);
    }
    return state;
  }

  /**
   * Full version-graph construction: apply deltas in dependency order
   * (every parent before its children) instead of arrival order.
   * Deltas whose parents never exist in the batch end up buffered,
   * exactly as they would under replay.
   */
  static buildFull(deltas: readonly Delta[]): VersionGraph {
    const graph = new VersionGraph();
    const remaining = [...deltas];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const delta = remaining[index]!;
        const resolved = delta.parents.every(
          (parent) => graph.has(parent) || graph.isQuarantined(parent),
        );
        if (resolved) {
          graph.apply(delta);
          remaining.splice(index, 1);
          progressed = true;
        }
      }
    }
    for (const delta of remaining) {
      graph.apply(delta);
    }
    return graph;
  }

  /** Structural equivalence: same applied/pending/quarantined sets, same
   *  heads, and identical per-head branch histories. */
  equals(other: VersionGraph): boolean {
    const sameList = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((value, index) => value === b[index]);
    if (!sameList(this.appliedIds(), other.appliedIds())) return false;
    if (!sameList(this.pendingIds(), other.pendingIds())) return false;
    if (!sameList(this.quarantinedIds(), other.quarantinedIds())) return false;
    const heads = this.heads();
    if (!sameList(heads, other.heads())) return false;
    for (const head of heads) {
      const mine = this.history(head).map((delta) => delta.id);
      const theirs = other.history(head).map((delta) => delta.id);
      if (!sameList(mine, theirs)) return false;
    }
    return true;
  }
}

/** Convenience: mint a well-formed delta with a correct digest. */
export function makeDelta(
  id: string,
  parents: readonly string[],
  payload: unknown,
): Delta {
  return {
    id,
    parents: [...parents],
    payload,
    digest: computeDigest(id, parents, payload),
  };
}
