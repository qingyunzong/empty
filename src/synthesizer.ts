import { deepEqual } from './equality.js';
import {
  ConflictingEventError,
  ConfirmationReadError,
  EventSynthesisError,
  InvalidEventError,
  NoHeldEventError,
  SynthesizerStoppedError,
  WriteOutcomeUnknownError,
} from './errors.js';
import type { ConfirmationStore } from './store.js';

/** A single event arriving at the collection host. */
export interface EventEnvelope {
  /** Unique event identifier. */
  id: string;
  /**
   * Ids of the event's direct predecessors. Order and duplicates are
   * irrelevant: the set of ids is what defines the dependency edge set.
   */
  predecessors: readonly string[];
  /** Arbitrary caller-defined payload. */
  payload: unknown;
}

/** Result of closing the input: missing predecessors and dependency cycles. */
export interface SynthesisReport {
  /**
   * Ids that are referenced as direct predecessors but whose own event never
   * arrived. Sorted by lexicographic id.
   */
  missingPredecessors: string[];
  /**
   * Strongly connected components of size >= 2, plus self loops, found among
   * the events that did arrive. Every component is a lexicographically sorted
   * id list and the components themselves are sorted by their smallest id.
   * Missing nodes never appear here.
   */
  cycles: string[][];
}

/**
 * Reorders arbitrarily-arriving, possibly-duplicated events into
 * predecessor-respecting delivery order for a single consumer.
 */
export class EventSynthesizer {
  readonly #store: ConfirmationStore;
  readonly #events = new Map<string, EventEnvelope>();
  readonly #confirmed = new Set<string>();
  /** Ids whose confirmation write had an unknown outcome and need a read. */
  readonly #pendingWrites = new Set<string>();
  /** The single event currently handed out, or `null` when idle. */
  #heldId: string | null = null;
  #stopped: { reason: unknown } | null = null;

  constructor(store: ConfirmationStore) {
    this.#store = store;
  }

  /** Whether the synthesizer has stopped because a marker read failed. */
  get stopped(): boolean {
    return this.#stopped !== null;
  }

  /** Id of the event currently held by the consumer, or `null`. */
  get heldId(): string | null {
    return this.#heldId;
  }

  /** Ids confirmed either directly or discovered via a recovery read. */
  get confirmedIds(): readonly string[] {
    return [...this.#confirmed].sort();
  }

  /** Ids whose events have arrived and have not been confirmed yet. */
  get unconfirmedIds(): readonly string[] {
    return [...this.#events.keys()]
      .filter((id) => !this.#confirmed.has(id))
      .sort();
  }

  /**
   * Accepts an event. Out-of-order arrival is fine. A second envelope with an
   * already-known id must be content-identical (same predecessor set and
   * payload); otherwise it is rejected with {@link ConflictingEventError}.
   */
  ingest(envelope: EventEnvelope): void {
    this.#requireRunning('ingest');
    validateEnvelope(envelope);

    const existing = this.#events.get(envelope.id);
    if (existing !== undefined) {
      if (!sameContent(existing, envelope)) {
        throw new ConflictingEventError(envelope.id);
      }
      // Exact duplicate: arrival is idempotent and changes nothing.
      return;
    }
    this.#events.set(envelope.id, {
      id: envelope.id,
      predecessors: [...new Set(envelope.predecessors)].sort(),
      payload: envelope.payload,
    });
  }

  /**
   * Returns the next event for the single consumer, or `null` when nothing is
   * deliverable. While an event is held the same event is returned until it is
   * confirmed or explicitly released, so no other event can be taken.
   *
   * An event is ready only when every direct predecessor already carries a
   * confirmation marker; among ready, unconfirmed events the lexicographically
   * smallest id wins.
   *
   * Marker reads triggered by unknown write outcomes or recovery run before
   * selection. A read failure stops the synthesizer.
   */
  async take(): Promise<EventEnvelope | null> {
    this.#requireRunning('take');
    await this.#resolvePendingWrites();
    if (this.#heldId !== null) {
      return this.#toEnvelope(this.#heldId);
    }

    const eligible = this.#eligibleIds();
    if (eligible.length === 0) {
      return null;
    }
    const nextId = eligible[0]!;
    this.#heldId = nextId;
    return this.#toEnvelope(nextId);
  }

  /**
   * Confirms the held event by durably writing its marker. On success the
   * event is released and will never be redelivered.
   *
   * A write failure has an unknown outcome: the event stays held and the id
   * is queued for a marker read on the next {@link take}/{@link release}.
   */
  async confirm(): Promise<void> {
    this.#requireRunning('confirm');
    const eventId = this.#requireHeld();

    await this.#resolvePendingWrites();
    if (this.#confirmed.has(eventId)) {
      // Already confirmed by a previous write whose response was lost.
      this.#heldId = null;
      return;
    }

    try {
      await this.#store.markConfirmed(eventId);
    } catch (cause) {
      this.#pendingWrites.add(eventId);
      throw new WriteOutcomeUnknownError(eventId, cause);
    }
    this.#confirmed.add(eventId);
    this.#heldId = null;
  }

  /**
   * Explicitly gives the held event back without confirming it. If its
   * confirmation marker had an unknown write outcome the marker is read first;
   * an event discovered as confirmed is released permanently, otherwise it
   * becomes eligible for redelivery with the same id.
   */
  async release(): Promise<void> {
    this.#requireRunning('release');
    const eventId = this.#requireHeld();

    await this.#resolvePendingWrites();
    this.#heldId = null;
    if (this.#confirmed.has(eventId) || !this.#events.has(eventId)) {
      return;
    }
  }

  /**
   * Reconciles a fresh instance with durable markers after a process restart.
   * Events must be re-ingested first. Each given id is read from the store
   * exactly once: a confirmed id is marked locally and never redelivered; an
   * unconfirmed id stays eligible for redelivery with the same id. A read
   * failure stops the synthesizer.
   */
  async recover(eventIds: readonly string[]): Promise<void> {
    this.#requireRunning('recover');
    for (const eventId of eventIds) {
      if (this.#confirmed.has(eventId)) {
        continue;
      }
      const confirmed = await this.#readMarker(eventId);
      if (confirmed) {
        this.#confirmed.add(eventId);
      }
    }
  }

  /**
   * Closes the input and reports, based on the events that arrived:
   *  - direct predecessors whose own event never arrived;
   *  - strongly connected cycles (self loops included) in the dependency
   *    graph, so missing nodes are never mistaken for cycles.
   */
  finish(): SynthesisReport {
    const missing = new Set<string>();
    for (const envelope of this.#events.values()) {
      for (const predecessorId of envelope.predecessors) {
        if (!this.#events.has(predecessorId)) {
          missing.add(predecessorId);
        }
      }
    }

    return {
      missingPredecessors: [...missing].sort(),
      cycles: findCycles(this.#events),
    };
  }

  #requireRunning(operation: string): void {
    if (this.#stopped !== null) {
      throw new SynthesizerStoppedError(
        `event synthesizer is stopped; '${operation}' is unavailable until recovery`,
        this.#stopped.reason,
      );
    }
  }

  #requireHeld(): string {
    if (this.#heldId === null) {
      throw new NoHeldEventError('no event is currently held by the consumer');
    }
    return this.#heldId;
  }

  async #resolvePendingWrites(): Promise<void> {
    for (const eventId of [...this.#pendingWrites]) {
      this.#pendingWrites.delete(eventId);
      const confirmed = await this.#readMarker(eventId);
      if (confirmed) {
        this.#confirmed.add(eventId);
        if (this.#heldId === eventId) {
          this.#heldId = null;
        }
      }
    }
  }

  async #readMarker(eventId: string): Promise<boolean> {
    try {
      return await this.#store.isConfirmed(eventId);
    } catch (cause) {
      this.#stopped = { reason: cause };
      throw new ConfirmationReadError(eventId, cause);
    }
  }

  #eligibleIds(): string[] {
    const eligible: string[] = [];
    for (const envelope of this.#events.values()) {
      if (this.#confirmed.has(envelope.id)) {
        continue;
      }
      const everyPredecessorConfirmed = envelope.predecessors.every(
        (predecessorId) => this.#confirmed.has(predecessorId),
      );
      if (everyPredecessorConfirmed) {
        eligible.push(envelope.id);
      }
    }
    return eligible.sort();
  }

  #toEnvelope(eventId: string): EventEnvelope {
    const envelope = this.#events.get(eventId);
    if (envelope === undefined) {
      // Only reachable if held state and events diverge, which cannot happen
      // through the public API; keep the invariant explicit.
      throw new EventSynthesisError(
        `internal error: held event '${eventId}' is unknown`,
      );
    }
    return envelope;
  }
}

function validateEnvelope(envelope: EventEnvelope): void {
  if (
    envelope === null ||
    typeof envelope !== 'object' ||
    typeof envelope.id !== 'string' ||
    envelope.id.length === 0
  ) {
    throw new InvalidEventError('event envelope must have a non-empty string id');
  }
  if (!Array.isArray(envelope.predecessors)) {
    throw new InvalidEventError(
      `event '${envelope.id}' must carry a predecessors array`,
    );
  }
  if (envelope.predecessors.some((id) => typeof id !== 'string')) {
    throw new InvalidEventError(
      `event '${envelope.id}' has a non-string predecessor id`,
    );
  }
}

function sameContent(left: EventEnvelope, right: EventEnvelope): boolean {
  const leftPredecessors = new Set(left.predecessors);
  const rightPredecessors = new Set(right.predecessors);
  if (leftPredecessors.size !== rightPredecessors.size) {
    return false;
  }
  for (const predecessorId of leftPredecessors) {
    if (!rightPredecessors.has(predecessorId)) {
      return false;
    }
  }
  return deepEqual(left.payload, right.payload);
}

/**
 * Tarjan's strongly connected components over the graph of arrived events.
 * Edges point from an event to its direct predecessors; an SCC with more than
 * one node, or a node pointing at itself, is a dependency cycle. Nodes whose
 * event never arrived are not part of the graph and therefore cannot appear
 * in a reported cycle.
 */
function findCycles(events: Map<string, EventEnvelope>): string[][] {
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let nextIndex = 0;

  const visit = (nodeId: string): void => {
    indices.set(nodeId, nextIndex);
    lowLinks.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    const envelope = events.get(nodeId);
    const predecessorIds = envelope === undefined ? [] : envelope.predecessors;
    for (const predecessorId of predecessorIds) {
      // Missing nodes are not vertices of the arrived-event graph.
      if (!events.has(predecessorId)) {
        continue;
      }
      if (!indices.has(predecessorId)) {
        visit(predecessorId);
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId)!, lowLinks.get(predecessorId)!),
        );
      } else if (onStack.has(predecessorId)) {
        lowLinks.set(
          nodeId,
          Math.min(lowLinks.get(nodeId)!, indices.get(predecessorId)!),
        );
      }
    }

    if (lowLinks.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = [];
      let memberId: string;
      do {
        memberId = stack.pop()!;
        onStack.delete(memberId);
        component.push(memberId);
      } while (memberId !== nodeId);

      const isCycle =
        component.length > 1 ||
        (component.length === 1 &&
          predecessorIds.includes(component[0]!));
      if (isCycle) {
        cycles.push(component.sort());
      }
    }
  };

  for (const nodeId of [...events.keys()].sort()) {
    if (!indices.has(nodeId)) {
      visit(nodeId);
    }
  }

  return cycles.sort((left, right) => {
    const leftHead = left[0]!;
    const rightHead = right[0]!;
    return leftHead < rightHead ? -1 : leftHead > rightHead ? 1 : 0;
  });
}
