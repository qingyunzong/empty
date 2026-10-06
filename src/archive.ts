import type { ArchiveEvent, DocId, EventId, RestoreEvent, UpdateEvent } from './events.js';

export interface Branch {
  /** Id of the update event this content originates from (content provenance). */
  readonly updateId: EventId;
  readonly content: string;
}

export type DocStatus = 'missing' | 'active' | 'deleted';

export interface DocState {
  readonly status: DocStatus;
  /** Delete events not cancelled by any restore (live tombstones). */
  readonly liveDeletes: readonly EventId[];
  /** Delete events cancelled by at least one restore. */
  readonly restoredDeletes: readonly EventId[];
  /** Content heads of the update DAG; concurrent updates keep parallel branches. */
  readonly branches: readonly Branch[];
}

function compareIds(a: EventId, b: EventId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * State-based CRDT archive. Merge is set union over events keyed by id,
 * so it is idempotent, commutative and associative. All derived state is a
 * pure function of the event set, hence independent of delivery order.
 */
export class Archive {
  private readonly events = new Map<EventId, ArchiveEvent>();

  get size(): number {
    return this.events.size;
  }

  has(id: EventId): boolean {
    return this.events.has(id);
  }

  /** Apply one event. Returns false when the event was already known (idempotent). */
  apply(event: ArchiveEvent): boolean {
    if (this.events.has(event.id)) return false;
    this.events.set(event.id, event);
    return true;
  }

  /** Merge another archive or any event iterable. Returns newly added event ids. */
  merge(source: Archive | Iterable<ArchiveEvent>): EventId[] {
    const added: EventId[] = [];
    const iterable = source instanceof Archive ? source.allEvents() : source;
    for (const event of iterable) {
      if (this.apply(event)) added.push(event.id);
    }
    return added.sort(compareIds);
  }

  allEvents(): ArchiveEvent[] {
    return [...this.events.values()].sort((a, b) => compareIds(a.id, b.id));
  }

  eventIds(): EventId[] {
    return [...this.events.keys()].sort(compareIds);
  }

  liveDeletes(doc: DocId): EventId[] {
    const restored = new Set<EventId>();
    for (const event of this.events.values()) {
      if (event.kind === 'restore' && event.doc === doc) {
        restored.add((event as RestoreEvent).restores);
      }
    }
    const live: EventId[] = [];
    for (const event of this.events.values()) {
      if (event.kind === 'delete' && event.doc === doc && !restored.has(event.id)) {
        live.push(event.id);
      }
    }
    return live.sort(compareIds);
  }

  restoredDeletes(doc: DocId): EventId[] {
    const restored = new Set<EventId>();
    for (const event of this.events.values()) {
      if (event.kind === 'restore' && event.doc === doc) {
        restored.add((event as RestoreEvent).restores);
      }
    }
    const done: EventId[] = [];
    for (const event of this.events.values()) {
      if (event.kind === 'delete' && event.doc === doc && restored.has(event.id)) {
        done.push(event.id);
      }
    }
    return done.sort(compareIds);
  }

  /** Heads of the update DAG for `doc`; concurrent updates yield one branch each. */
  heads(doc: DocId): Branch[] {
    const updates: UpdateEvent[] = [];
    for (const event of this.events.values()) {
      if (event.kind === 'update' && event.doc === doc) updates.push(event);
    }
    const referenced = new Set<EventId>();
    for (const update of updates) {
      for (const dep of update.deps) referenced.add(dep);
    }
    return updates
      .filter((update) => !referenced.has(update.id))
      .map((update) => ({ updateId: update.id, content: update.content }))
      .sort((a, b) => compareIds(a.updateId, b.updateId));
  }

  state(doc: DocId): DocState {
    let any = false;
    for (const event of this.events.values()) {
      if (event.doc === doc) {
        any = true;
        break;
      }
    }
    if (!any) {
      return { status: 'missing', liveDeletes: [], restoredDeletes: [], branches: [] };
    }
    const live = this.liveDeletes(doc);
    return {
      status: live.length > 0 ? 'deleted' : 'active',
      liveDeletes: live,
      restoredDeletes: this.restoredDeletes(doc),
      branches: this.heads(doc),
    };
  }

  /** Deterministic full snapshot, suitable for deep-equal convergence checks. */
  snapshot(): Record<DocId, DocState> {
    const docs = new Set<DocId>();
    for (const event of this.events.values()) docs.add(event.doc);
    const out: Record<DocId, DocState> = {};
    for (const doc of [...docs].sort()) out[doc] = this.state(doc);
    return out;
  }
}
