/**
 * Event-sourced document archive with CRDT merge semantics.
 *
 * Model
 * -----
 * Every mutation is an immutable event with a unique id, a lamport clock and
 * an explicit causal frontier (`deps`). Replicas exchange events; `merge` is
 * set-union over events keyed by id, hence idempotent, commutative and
 * associative. All document state is derived deterministically from the event
 * set, so replicas that have seen the same events agree on the state.
 *
 * Delete / restore semantics
 * --------------------------
 * - `delete` creates a tombstone identified by the delete event id (the
 *   "delete version").
 * - `restore` must reference a concrete delete version (`deleteRef`) and
 *   cancels exactly that tombstone. A document is deleted while at least one
 *   tombstone remains uncancelled.
 * - `update` never resurrects a document: updates that have not observed a
 *   delete (concurrent with it) do not restore the document, and they also do
 *   not contribute content to a branch rooted at a later restore.
 * - Concurrent restores of the same delete version each open a branch; all
 *   branches are preserved. Causally ordered restores collapse to the latest
 *   one.
 */

export type EventId = string;

interface BaseEvent {
  readonly id: EventId;
  readonly doc: string;
  readonly lamport: number;
  /** Causal frontier: ids of the maximal events the author had observed. */
  readonly deps: readonly EventId[];
}

export interface UpdateEvent extends BaseEvent {
  readonly kind: "update";
  readonly content: string;
}

export interface DeleteEvent extends BaseEvent {
  readonly kind: "delete";
}

export interface RestoreEvent extends BaseEvent {
  readonly kind: "restore";
  /** The exact delete version this restore cancels. */
  readonly deleteRef: EventId;
}

export type ArchiveEvent = UpdateEvent | DeleteEvent | RestoreEvent;

export interface TombstoneInfo {
  readonly deleteId: EventId;
  readonly active: boolean;
  readonly cancelledBy: readonly EventId[];
}

export interface Branch {
  /** Restore event that roots this branch, or null for the genesis branch. */
  readonly rootRestoreId: EventId | null;
  readonly content: string | null;
  /** Update event that supplied the content (provenance), or null. */
  readonly contentFrom: EventId | null;
}

export type DocStatus = "empty" | "active" | "deleted";

export interface DocumentState {
  readonly doc: string;
  readonly status: DocStatus;
  readonly branches: readonly Branch[];
  readonly tombstones: readonly TombstoneInfo[];
}

export class Archive {
  private readonly events = new Map<EventId, ArchiveEvent>();
  private readonly frontier = new Set<EventId>();
  private lamport = 0;
  private counter = 0;

  constructor(readonly replicaId: string) {}

  /** Apply a local update. Never resurrects a deleted document. */
  update(doc: string, content: string): UpdateEvent {
    return this.emit({ kind: "update", doc, content });
  }

  /** Delete a document, creating a tombstone versioned by the event id. */
  delete(doc: string): DeleteEvent {
    return this.emit({ kind: "delete", doc });
  }

  /**
   * Restore a document by cancelling exactly the referenced delete version.
   * Throws unless `deleteRef` is a known delete event of the same document.
   */
  restore(doc: string, deleteRef: EventId): RestoreEvent {
    const target = this.events.get(deleteRef);
    if (!target || target.kind !== "delete" || target.doc !== doc) {
      throw new Error(
        `restore(${doc}) requires a known delete version of that document, got ${deleteRef}`,
      );
    }
    return this.emit({ kind: "restore", doc, deleteRef });
  }

  /**
   * Merge events (or another replica's archive) into this one.
   * Idempotent: already-known event ids are ignored.
   */
  merge(source: Iterable<ArchiveEvent> | Archive): this {
    const incoming = source instanceof Archive ? source.allEvents() : source;
    for (const event of incoming) {
      if (this.events.has(event.id)) continue;
      this.events.set(event.id, event);
      this.lamport = Math.max(this.lamport, event.lamport);
      for (const dep of event.deps) this.frontier.delete(dep);
      this.frontier.add(event.id);
    }
    return this;
  }

  has(id: EventId): boolean {
    return this.events.has(id);
  }

  get size(): number {
    return this.events.size;
  }

  allEvents(): ArchiveEvent[] {
    return [...this.events.values()];
  }

  /** True when `a` is in the causal past of `b` (a !== b). */
  happensBefore(a: EventId, b: EventId): boolean {
    const start = this.events.get(b);
    if (!start || a === b) return false;
    const visited = new Set<EventId>();
    const stack: EventId[] = [...start.deps];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === a) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      const event = this.events.get(id);
      if (event) stack.push(...event.deps);
    }
    return false;
  }

  /** Derive the materialized state of one document. */
  documentState(doc: string): DocumentState {
    const events = this.allEvents().filter((event) => event.doc === doc);
    if (events.length === 0) {
      return { doc, status: "empty", branches: [], tombstones: [] };
    }
    const updates = events.filter((e): e is UpdateEvent => e.kind === "update");
    const deletes = events.filter((e): e is DeleteEvent => e.kind === "delete");
    const restores = events.filter((e): e is RestoreEvent => e.kind === "restore");

    const cancelledBy = new Map<EventId, EventId[]>();
    for (const del of deletes) cancelledBy.set(del.id, []);
    const effectiveRestores: RestoreEvent[] = [];
    for (const restore of restores) {
      const list = cancelledBy.get(restore.deleteRef);
      if (list) {
        list.push(restore.id);
        effectiveRestores.push(restore);
      }
    }

    const tombstones: TombstoneInfo[] = deletes
      .map((del) => {
        const cancellers = cancelledBy.get(del.id)!.slice().sort();
        return { deleteId: del.id, active: cancellers.length === 0, cancelledBy: cancellers };
      })
      .sort((x, y) => (x.deleteId < y.deleteId ? -1 : 1));

    if (tombstones.some((t) => t.active)) {
      return { doc, status: "deleted", branches: [], tombstones };
    }

    const branches: Branch[] =
      effectiveRestores.length === 0
        ? [this.genesisBranch(updates)]
        : this.restoreRoots(effectiveRestores).map((root) =>
            this.restoreBranch(root, updates),
          );
    branches.sort((x, y) =>
      (x.rootRestoreId ?? "") < (y.rootRestoreId ?? "") ? -1 : 1,
    );
    return { doc, status: "active", branches, tombstones };
  }

  private genesisBranch(updates: UpdateEvent[]): Branch {
    const winner = latestByLww(updates);
    return {
      rootRestoreId: null,
      content: winner?.content ?? null,
      contentFrom: winner?.id ?? null,
    };
  }

  private restoreBranch(root: RestoreEvent, updates: UpdateEvent[]): Branch {
    const postUpdates = updates.filter((u) => this.happensBefore(root.id, u.id));
    const winner = latestByLww(postUpdates);
    if (winner) {
      return { rootRestoreId: root.id, content: winner.content, contentFrom: winner.id };
    }
    const base = this.contentBefore(root.deleteRef, updates);
    return {
      rootRestoreId: root.id,
      content: base?.content ?? null,
      contentFrom: base?.id ?? null,
    };
  }

  /** Content that was live immediately before the given delete version. */
  private contentBefore(deleteId: EventId, updates: UpdateEvent[]): UpdateEvent | null {
    return latestByLww(updates.filter((u) => this.happensBefore(u.id, deleteId)));
  }

  /** Causally maximal restores: concurrent restores each keep a branch. */
  private restoreRoots(restores: RestoreEvent[]): RestoreEvent[] {
    return restores.filter(
      (r) => !restores.some((other) => other.id !== r.id && this.happensBefore(r.id, other.id)),
    );
  }

  private emit<T extends UpdateEvent | DeleteEvent | RestoreEvent>(
    fields: Omit<T, "id" | "lamport" | "deps">,
  ): T {
    const event = {
      ...fields,
      id: `${this.replicaId}#${++this.counter}`,
      lamport: ++this.lamport,
      deps: [...this.frontier],
    } as unknown as T;
    this.merge([event]);
    return event;
  }
}

/** Last-writer-wins pick: highest lamport clock, ties broken by event id. */
function latestByLww<T extends { id: EventId; lamport: number }>(events: T[]): T | null {
  let best: T | null = null;
  for (const event of events) {
    if (
      !best ||
      event.lamport > best.lamport ||
      (event.lamport === best.lamport && event.id > best.id)
    ) {
      best = event;
    }
  }
  return best;
}
