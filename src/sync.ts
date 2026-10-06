/**
 * Prerequisite-based object sync engine.
 *
 * Every change carries the version it was built on (`base`). A change is
 * applied only when the object's current cursor equals `base`, i.e. its
 * prerequisite has been applied. Out-of-order changes are buffered until
 * their prerequisite arrives; the buffer is bounded by a budget and the
 * caller is asked to retry later (backpressure) when it is full. Deletes
 * advance the cursor like any other change. Snapshots capture both the
 * applied state and the still-pending buffer so recovery loses nothing.
 */

export type Version = number;

/** Version of an object that has never been seen. */
export const INITIAL_VERSION: Version = 0;

export type Op = "put" | "delete";

export interface Change<V = unknown> {
  objectId: string;
  /** Version the object reaches after this change is applied. */
  version: Version;
  /** Prerequisite: the cursor the object must be at for this change to apply. */
  base: Version;
  op: Op;
  /** Payload for `put`; ignored for `delete`. */
  value?: V;
}

export type ReceiveStatus =
  | "applied" // applied immediately (may also have drained pending changes)
  | "buffered" // prerequisite missing; cached for later
  | "duplicate" // already applied or already pending
  | "backpressure"; // prerequisite missing and the pending budget is full

export interface ReceiveResult {
  status: ReceiveStatus;
  /** Cursor of the object after this call. */
  cursor: Version;
  /** Number of pending changes still buffered. */
  pending: number;
}

interface ObjectState<V> {
  cursor: Version;
  /** Absent when the object is deleted (or never existed). */
  value?: V;
}

export interface Snapshot<V = unknown> {
  format: 1;
  /** Cursor per known object; `value` is absent for deleted objects. */
  objects: Record<string, { cursor: Version; value?: V }>;
  /** Buffered changes awaiting their prerequisites, in arrival order. */
  pending: Change<V>[];
}

export interface SyncStoreOptions {
  /** Maximum number of buffered out-of-order changes. Default 1024. */
  pendingBudget?: number;
}

const DEFAULT_PENDING_BUDGET = 1024;

export class SyncStore<V = unknown> {
  private readonly budget: number;
  private readonly objects = new Map<string, ObjectState<V>>();
  private readonly pending: Change<V>[] = [];

  constructor(options: SyncStoreOptions = {}) {
    this.budget = options.pendingBudget ?? DEFAULT_PENDING_BUDGET;
    if (!Number.isInteger(this.budget) || this.budget < 0) {
      throw new RangeError("pendingBudget must be a non-negative integer");
    }
  }

  /** Current cursor of an object; INITIAL_VERSION if never seen. */
  cursorOf(objectId: string): Version {
    return this.objects.get(objectId)?.cursor ?? INITIAL_VERSION;
  }

  /** Current value of a live object, undefined if deleted or unknown. */
  get(objectId: string): V | undefined {
    return this.objects.get(objectId)?.value;
  }

  /** Whether the object currently exists (not deleted). */
  has(objectId: string): boolean {
    const state = this.objects.get(objectId);
    return state !== undefined && state.value !== undefined;
  }

  /** Number of buffered out-of-order changes. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Remaining buffer capacity. */
  pendingHeadroom(): number {
    return this.budget - this.pending.length;
  }

  receive(change: Change<V>): ReceiveResult {
    const cursor = this.cursorOf(change.objectId);

    if (change.version <= cursor) {
      return { status: "duplicate", cursor, pending: this.pending.length };
    }

    if (change.base === cursor) {
      this.apply(change);
      this.drain();
      return {
        status: "applied",
        cursor: this.cursorOf(change.objectId),
        pending: this.pending.length,
      };
    }

    if (this.isPending(change)) {
      return { status: "duplicate", cursor, pending: this.pending.length };
    }

    if (this.pending.length >= this.budget) {
      return { status: "backpressure", cursor, pending: this.pending.length };
    }

    this.pending.push(change);
    return { status: "buffered", cursor, pending: this.pending.length };
  }

  /**
   * Serialize applied state and the pending buffer. Restoring a snapshot
   * keeps every pending change so nothing in flight is lost.
   */
  snapshot(): Snapshot<V> {
    const objects: Snapshot<V>["objects"] = {};
    for (const [id, state] of this.objects) {
      const entry: { cursor: Version; value?: V } = { cursor: state.cursor };
      if (state.value !== undefined) entry.value = state.value;
      objects[id] = entry;
    }
    return {
      format: 1,
      objects,
      pending: this.pending.map((change) => ({ ...change })),
    };
  }

  static restore<V = unknown>(
    snapshot: Snapshot<V>,
    options: SyncStoreOptions = {},
  ): SyncStore<V> {
    if (snapshot.format !== 1) {
      throw new Error(`unsupported snapshot format: ${snapshot.format}`);
    }
    const store = new SyncStore<V>(options);
    for (const [id, entry] of Object.entries(snapshot.objects)) {
      const state: ObjectState<V> = { cursor: entry.cursor };
      if (entry.value !== undefined) state.value = entry.value;
      store.objects.set(id, state);
    }
    for (const change of snapshot.pending) {
      store.pending.push({ ...change });
    }
    // A restored pending change may already be applicable against the
    // restored state; settle whatever can settle now.
    store.drain();
    return store;
  }

  private apply(change: Change<V>): void {
    const state: ObjectState<V> = { cursor: change.version };
    if (change.op === "put") {
      if (change.value === undefined) {
        throw new Error(
          `put change for ${change.objectId}@${change.version} has no value`,
        );
      }
      state.value = change.value;
    }
    // Deletes advance the cursor but leave no value behind.
    this.objects.set(change.objectId, state);
  }

  /** Apply buffered changes whose prerequisites are now satisfied. */
  private drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = 0; index < this.pending.length; index += 1) {
        const change = this.pending[index];
        if (change.base === this.cursorOf(change.objectId)) {
          this.pending.splice(index, 1);
          this.apply(change);
          progressed = true;
          break;
        }
      }
    }
  }

  private isPending(change: Change<V>): boolean {
    return this.pending.some(
      (p) => p.objectId === change.objectId && p.version === change.version,
    );
  }
}
