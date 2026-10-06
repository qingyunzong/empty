export type EventId = string;
export type DocId = string;

interface BaseEvent {
  readonly id: EventId;
  readonly doc: DocId;
  readonly actor: string;
  /** Causal context: ids of every event the actor had observed. */
  readonly deps: readonly EventId[];
}

/** Sets document content. Never affects liveness: an update cannot resurrect a deleted doc. */
export interface UpdateEvent extends BaseEvent {
  readonly kind: 'update';
  readonly content: string;
}

/** A tombstone. Each delete is a distinct deletion version, addressable by its event id. */
export interface DeleteEvent extends BaseEvent {
  readonly kind: 'delete';
}

/** Cancels exactly one deletion version, referenced by `restores`. */
export interface RestoreEvent extends BaseEvent {
  readonly kind: 'restore';
  readonly restores: EventId;
}

export type ArchiveEvent = UpdateEvent | DeleteEvent | RestoreEvent;
