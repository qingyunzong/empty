import { Archive } from './archive.js';
import type { DeleteEvent, DocId, EventId, RestoreEvent, UpdateEvent } from './events.js';

/** A replica-bound event factory; deps capture the replica's current causal context. */
export class Client {
  private seq = 0;

  constructor(
    readonly actor: string,
    readonly archive: Archive,
  ) {}

  private nextId(): EventId {
    this.seq += 1;
    return `${this.actor}:${this.seq}`;
  }

  update(doc: DocId, content: string): UpdateEvent {
    const event: UpdateEvent = {
      kind: 'update',
      id: this.nextId(),
      doc,
      actor: this.actor,
      deps: this.archive.eventIds(),
      content,
    };
    this.archive.apply(event);
    return event;
  }

  delete(doc: DocId): DeleteEvent {
    const event: DeleteEvent = {
      kind: 'delete',
      id: this.nextId(),
      doc,
      actor: this.actor,
      deps: this.archive.eventIds(),
    };
    this.archive.apply(event);
    return event;
  }

  restore(doc: DocId, deleteId: EventId): RestoreEvent {
    const event: RestoreEvent = {
      kind: 'restore',
      id: this.nextId(),
      doc,
      actor: this.actor,
      deps: this.archive.eventIds(),
      restores: deleteId,
    };
    this.archive.apply(event);
    return event;
  }
}
