/**
 * Deterministic reconciliation of at-least-once object notifications with
 * periodic inventory snapshots.
 *
 * The reconciler stores facts, never conclusions.  Every call to
 * `reconcile()` replays the facts in canonical order, so the final state does
 * not depend on the order in which notifications or snapshots were ingested.
 */

export type NotificationOperation = "create" | "delete";

/** A single object notification from an at-least-once delivery channel. */
export interface ObjectNotification {
  /** Stable source event id. Duplicate deliveries must reuse it. */
  eventId: string;
  /** Fully qualified object key, for example `bucket/prefix/object`. */
  key: string;
  operation: NotificationOperation;
  /**
   * Source event time in any consistent, monotonically comparable numeric
   * unit (epoch milliseconds, a sequence number, ...). Ingestion order and
   * `receivedAt` are deliberately ignored when deciding what happened first.
   */
  eventTime: number;
  /** Optional object version or ETag carried by the notification. */
  version?: string;
  /**
   * Optional earliest time at which the object can be expected to be visible
   * to a reader. Defaults to `eventTime`.
   *
   * This is the escape hatch for "notification arrived before the object was
   * readable": a snapshot that is older than this watermark cannot turn the
   * create into a delete.
   */
  readableAfter?: number;
  /** Optional ingestion time. Kept as evidence, never used for ordering. */
  receivedAt?: number;
}

export interface InventoryObject {
  key: string;
  version?: string;
  etag?: string;
  size?: number;
  lastModified?: number;
}

/** A complete inventory listing as of `boundary`. */
export interface InventorySnapshot {
  /** Stable snapshot id. */
  snapshotId: string;
  /**
   * The snapshot is complete for every notification with
   * `eventTime <= boundary` (or `< boundary` when `boundaryInclusive` is
   * false).  This is the guard rail against deleting an object from a stale
   * snapshot that predates its create notification.
   */
  boundary: number;
  /** A string is shorthand for `{ key: string }`. */
  objects: Iterable<string | InventoryObject>;
  /** Optional capture time. Kept as evidence, never used for ordering. */
  capturedAt?: number;
}

export type CorrectionType = "delete" | "restore" | "create";

export type CorrectionReason =
  | "missing-from-snapshot"
  | "snapshot-contradicts-delete"
  | "snapshot-only-object";

export interface InventoryEvidence {
  snapshotId: string;
  boundary: number;
  present: boolean;
  /** Snapshot capture time, when the input supplied one. */
  capturedAt?: number;
  /** The inventory entry, when the object was present in the snapshot. */
  entry?: InventoryObject;
}

export interface CorrectionEvidence {
  /** Relevant notifications in canonical `(eventTime, eventId)` order. */
  notifications: ObjectNotification[];
  /**
   * The snapshot that caused the correction, preceded by the previous
   * covering snapshot when it shows the opposite presence state.
   */
  snapshots: InventoryEvidence[];
}

/**
 * A correction is an explicit disagreement between the notification-derived
 * expectation and an inventory snapshot.  It always carries both sides of the
 * evidence so a downstream writer can audit or replay it independently.
 */
export interface Correction {
  /** Stable id: identical inputs always produce the identical correction id. */
  id: string;
  type: CorrectionType;
  reason: CorrectionReason;
  key: string;
  /** Snapshot boundary at which the correction was established. */
  at: number;
  snapshotId: string;
  /** State implied by covered notifications. */
  expected: "present" | "absent";
  /** State observed in the inventory snapshot. */
  observed: "present" | "absent";
  /** Suggested idempotent action for a downstream index/table. */
  action: "delete" | "upsert";
  message: string;
  evidence: CorrectionEvidence;
}

export interface ReconciledObject {
  key: string;
  exists: boolean;
  version?: string;
  lastModified?: number;
  lastEventId?: string;
  lastEventTime?: number;
  lastOperation?: NotificationOperation;
  lastSnapshotId?: string;
  lastSnapshotBoundary?: number;
  /** True when the current state still depends on unconfirmed notifications. */
  pending: boolean;
}

export type PendingReason =
  | "no-snapshot"
  | "newer-than-snapshot"
  | "awaiting-visibility";

/**
 * A member of the pending-confirmation set.  The set is keyed by object, and
 * carries every notification that is still waiting for inventory coverage.
 */
export interface PendingObject {
  key: string;
  exists: boolean;
  reason: PendingReason;
  /** Newest still-unconfirmed notification. */
  notification: ObjectNotification;
  /** All still-unconfirmed notifications, in canonical order. */
  notifications: ObjectNotification[];
  lastSnapshotId?: string;
  lastSnapshotBoundary?: number;
}

export interface ReconciliationResult {
  /** Every observed key, including tombstones (`exists: false`). */
  objects: ReconciledObject[];
  /** Only actual disagreements, sorted by boundary then key then type. */
  corrections: Correction[];
  /** Pending-confirmation set, sorted by key. */
  pending: PendingObject[];
}

export interface ReconcilerOptions {
  /**
   * When true (default), a snapshot covers notifications whose
   * `eventTime === boundary`.  Set to false when the inventory capture
   * excludes events at exactly the boundary instant.
   */
  boundaryInclusive?: boolean;
}

export class ReconciliationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationInputError";
  }
}

interface NormalizedSnapshot {
  snapshotId: string;
  boundary: number;
  objects: InventoryObject[];
  byKey: Map<string, InventoryObject>;
  capturedAt?: number;
}

interface KeyReconciliation {
  object: ReconciledObject;
  corrections: Correction[];
  pending?: PendingObject;
}

const CORRECTION_ORDER: Record<CorrectionType, number> = {
  delete: 0,
  restore: 1,
  create: 2,
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNotifications(
  left: ObjectNotification,
  right: ObjectNotification,
): number {
  if (left.eventTime !== right.eventTime) {
    return left.eventTime - right.eventTime;
  }
  return compareStrings(left.eventId, right.eventId);
}

function compareSnapshots(
  left: NormalizedSnapshot,
  right: NormalizedSnapshot,
): number {
  if (left.boundary !== right.boundary) {
    return left.boundary - right.boundary;
  }
  return compareStrings(left.snapshotId, right.snapshotId);
}

function compareCorrections(left: Correction, right: Correction): number {
  if (left.at !== right.at) return left.at - right.at;
  const byKey = compareStrings(left.key, right.key);
  if (byKey !== 0) return byKey;
  return CORRECTION_ORDER[left.type] - CORRECTION_ORDER[right.type];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReconciliationInputError(
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReconciliationInputError(
      `${field} must be a finite number`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ReconciliationInputError(`${field} must be a string`);
  }
  return value;
}

function optionalFiniteNumber(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  return requireFiniteNumber(value, field);
}

function minOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function cloneNotification(
  notification: ObjectNotification,
): ObjectNotification {
  const copy: ObjectNotification = {
    eventId: notification.eventId,
    key: notification.key,
    operation: notification.operation,
    eventTime: notification.eventTime,
  };
  if (notification.version !== undefined) copy.version = notification.version;
  if (notification.readableAfter !== undefined) {
    copy.readableAfter = notification.readableAfter;
  }
  if (notification.receivedAt !== undefined) {
    copy.receivedAt = notification.receivedAt;
  }
  return copy;
}

function cloneInventoryObject(entry: InventoryObject): InventoryObject {
  const copy: InventoryObject = { key: entry.key };
  if (entry.version !== undefined) copy.version = entry.version;
  if (entry.etag !== undefined) copy.etag = entry.etag;
  if (entry.size !== undefined) copy.size = entry.size;
  if (entry.lastModified !== undefined) copy.lastModified = entry.lastModified;
  return copy;
}

function normalizeNotification(
  input: ObjectNotification,
): ObjectNotification {
  if (input === null || typeof input !== "object") {
    throw new ReconciliationInputError("notification must be an object");
  }
  const eventId = requireString(input.eventId, "notification.eventId");
  const key = requireString(input.key, "notification.key");
  if (input.operation !== "create" && input.operation !== "delete") {
    throw new ReconciliationInputError(
      'notification.operation must be "create" or "delete"',
    );
  }
  const eventTime = requireFiniteNumber(
    input.eventTime,
    "notification.eventTime",
  );
  const version = optionalString(input.version, "notification.version");
  const readableAfter = optionalFiniteNumber(
    input.readableAfter,
    "notification.readableAfter",
  );
  const receivedAt = optionalFiniteNumber(
    input.receivedAt,
    "notification.receivedAt",
  );

  const result: ObjectNotification = {
    eventId,
    key,
    operation: input.operation,
    eventTime,
  };
  if (version !== undefined) result.version = version;
  if (readableAfter !== undefined) result.readableAfter = readableAfter;
  if (receivedAt !== undefined) result.receivedAt = receivedAt;
  return result;
}

function notificationFingerprint(notification: ObjectNotification): string {
  return JSON.stringify([
    notification.eventId,
    notification.key,
    notification.operation,
    notification.eventTime,
    notification.version ?? null,
    notification.readableAfter ?? null,
  ]);
}

function normalizeInventoryObject(
  input: string | InventoryObject,
): InventoryObject {
  if (typeof input === "string") {
    return { key: requireString(input, "inventory key") };
  }
  if (input === null || typeof input !== "object") {
    throw new ReconciliationInputError(
      "inventory object must be a string or an object",
    );
  }
  const key = requireString(input.key, "inventory.key");
  const version = optionalString(input.version, "inventory.version");
  const etag = optionalString(input.etag, "inventory.etag");
  const size = optionalFiniteNumber(input.size, "inventory.size");
  const lastModified = optionalFiniteNumber(
    input.lastModified,
    "inventory.lastModified",
  );
  if (size !== undefined && size < 0) {
    throw new ReconciliationInputError("inventory.size must be >= 0");
  }

  const result: InventoryObject = { key };
  if (version !== undefined) result.version = version;
  if (etag !== undefined) result.etag = etag;
  if (size !== undefined) result.size = size;
  if (lastModified !== undefined) result.lastModified = lastModified;
  return result;
}

function inventoryFingerprint(entry: InventoryObject): string {
  return JSON.stringify([
    entry.key,
    entry.version ?? null,
    entry.etag ?? null,
    entry.size ?? null,
    entry.lastModified ?? null,
  ]);
}

function normalizeSnapshot(input: InventorySnapshot): NormalizedSnapshot {
  if (input === null || typeof input !== "object") {
    throw new ReconciliationInputError("snapshot must be an object");
  }
  const snapshotId = requireString(input.snapshotId, "snapshot.snapshotId");
  const boundary = requireFiniteNumber(input.boundary, "snapshot.boundary");
  const capturedAt = optionalFiniteNumber(
    input.capturedAt,
    "snapshot.capturedAt",
  );
  if (
    input.objects === null ||
    input.objects === undefined ||
    typeof input.objects === "string" ||
    typeof input.objects[Symbol.iterator] !== "function"
  ) {
    throw new ReconciliationInputError(
      "snapshot.objects must be an iterable of keys or inventory objects",
    );
  }

  const byKey = new Map<string, InventoryObject>();
  const fingerprints = new Map<string, string>();
  for (const raw of input.objects) {
    const entry = normalizeInventoryObject(raw);
    const fingerprint = inventoryFingerprint(entry);
    const existing = fingerprints.get(entry.key);
    if (existing !== undefined) {
      if (existing !== fingerprint) {
        throw new ReconciliationInputError(
          `snapshot ${snapshotId} contains conflicting entries for ${entry.key}`,
        );
      }
      continue;
    }
    fingerprints.set(entry.key, fingerprint);
    byKey.set(entry.key, entry);
  }

  const objects = [...byKey.values()].sort((left, right) =>
    compareStrings(inventoryFingerprint(left), inventoryFingerprint(right)),
  );
  const result: NormalizedSnapshot = {
    snapshotId,
    boundary,
    objects,
    byKey,
  };
  if (capturedAt !== undefined) result.capturedAt = capturedAt;
  return result;
}

function snapshotFingerprint(snapshot: NormalizedSnapshot): string {
  return JSON.stringify([
    snapshot.snapshotId,
    snapshot.boundary,
    snapshot.objects.map(inventoryFingerprint),
  ]);
}

function uniqueSortedNotifications(
  notifications: readonly ObjectNotification[],
): ObjectNotification[] {
  const byId = new Map<string, ObjectNotification>();
  for (const notification of notifications) {
    if (!byId.has(notification.eventId)) {
      byId.set(notification.eventId, notification);
    }
  }
  return [...byId.values()]
    .sort(compareNotifications)
    .map(cloneNotification);
}

/**
 * Stateful, importable reconciler.
 *
 * Ingesting the same fact twice is a no-op.  Ingesting facts in a different
 * order yields the same result as long as the fact set is the same.
 */
export class ObjectReconciler {
  #boundaryInclusive: boolean;
  #notifications = new Map<string, ObjectNotification>();
  #snapshots = new Map<string, NormalizedSnapshot>();

  constructor(options: ReconcilerOptions = {}) {
    this.#boundaryInclusive = options.boundaryInclusive ?? true;
  }

  get notificationCount(): number {
    return this.#notifications.size;
  }

  get snapshotCount(): number {
    return this.#snapshots.size;
  }

  /**
   * Adds one notification.  Returns `true` when it was new and `false` for an
   * identical duplicate delivery.
   */
  ingestNotification(notification: ObjectNotification): boolean {
    const normalized = normalizeNotification(notification);
    const existing = this.#notifications.get(normalized.eventId);
    if (existing === undefined) {
      this.#notifications.set(normalized.eventId, normalized);
      return true;
    }

    if (
      notificationFingerprint(existing) !==
      notificationFingerprint(normalized)
    ) {
      throw new ReconciliationInputError(
        `conflicting duplicate notification id ${normalized.eventId}`,
      );
    }

    const receivedAt = minOptional(existing.receivedAt, normalized.receivedAt);
    if (receivedAt !== existing.receivedAt) {
      const merged = cloneNotification(existing);
      if (receivedAt === undefined) {
        delete merged.receivedAt;
      } else {
        merged.receivedAt = receivedAt;
      }
      this.#notifications.set(normalized.eventId, merged);
    }
    return false;
  }

  ingestSnapshot(snapshot: InventorySnapshot): boolean {
    const normalized = normalizeSnapshot(snapshot);
    const existing = this.#snapshots.get(normalized.snapshotId);
    if (existing === undefined) {
      this.#snapshots.set(normalized.snapshotId, normalized);
      return true;
    }

    if (snapshotFingerprint(existing) !== snapshotFingerprint(normalized)) {
      throw new ReconciliationInputError(
        `conflicting duplicate snapshot id ${normalized.snapshotId}`,
      );
    }

    const capturedAt = minOptional(existing.capturedAt, normalized.capturedAt);
    if (capturedAt !== existing.capturedAt) {
      existing.capturedAt = capturedAt;
    }
    return false;
  }

  ingestNotifications(notifications: Iterable<ObjectNotification>): number {
    let inserted = 0;
    for (const notification of notifications) {
      if (this.ingestNotification(notification)) inserted += 1;
    }
    return inserted;
  }

  ingestSnapshots(snapshots: Iterable<InventorySnapshot>): number {
    let inserted = 0;
    for (const snapshot of snapshots) {
      if (this.ingestSnapshot(snapshot)) inserted += 1;
    }
    return inserted;
  }

  /** Alias for callers that use `add*` terminology. */
  addNotification(notification: ObjectNotification): boolean {
    return this.ingestNotification(notification);
  }

  /** Alias for callers that use `add*` terminology. */
  addSnapshot(snapshot: InventorySnapshot): boolean {
    return this.ingestSnapshot(snapshot);
  }

  /** Alias for callers that use `record*` terminology. */
  recordNotification(notification: ObjectNotification): boolean {
    return this.ingestNotification(notification);
  }

  /** Alias for callers that use `record*` terminology. */
  recordSnapshot(snapshot: InventorySnapshot): boolean {
    return this.ingestSnapshot(snapshot);
  }

  clear(): void {
    this.#notifications.clear();
    this.#snapshots.clear();
  }

  getPending(): PendingObject[] {
    return this.reconcile().pending;
  }

  getCorrections(): Correction[] {
    return this.reconcile().corrections;
  }

  getObjects(): ReconciledObject[] {
    return this.reconcile().objects;
  }

  reconcile(): ReconciliationResult {
    const notificationsByKey = new Map<string, ObjectNotification[]>();
    for (const notification of this.#notifications.values()) {
      const list = notificationsByKey.get(notification.key);
      if (list === undefined) {
        notificationsByKey.set(notification.key, [notification]);
      } else {
        list.push(notification);
      }
    }
    for (const list of notificationsByKey.values()) {
      list.sort(compareNotifications);
    }

    const snapshots = [...this.#snapshots.values()].sort(compareSnapshots);
    const keys = new Set<string>(notificationsByKey.keys());
    for (const snapshot of snapshots) {
      for (const key of snapshot.byKey.keys()) keys.add(key);
    }

    const objects: ReconciledObject[] = [];
    const corrections: Correction[] = [];
    const pending: PendingObject[] = [];

    for (const key of keys) {
      const result = this.#reconcileKey(
        key,
        notificationsByKey.get(key) ?? [],
        snapshots,
      );
      objects.push(result.object);
      corrections.push(...result.corrections);
      if (result.pending !== undefined) pending.push(result.pending);
    }

    objects.sort((left, right) => compareStrings(left.key, right.key));
    corrections.sort(compareCorrections);
    pending.sort((left, right) => compareStrings(left.key, right.key));
    return { objects, corrections, pending };
  }

  #covers(eventTime: number, boundary: number): boolean {
    return this.#boundaryInclusive
      ? eventTime <= boundary
      : eventTime < boundary;
  }

  #reaches(boundary: number, watermark: number): boolean {
    return this.#boundaryInclusive
      ? boundary >= watermark
      : boundary > watermark;
  }

  #reconcileKey(
    key: string,
    events: ObjectNotification[],
    snapshots: NormalizedSnapshot[],
  ): KeyReconciliation {
    let eventIndex = 0;
    let exists = false;
    let known = false;
    let lastKnownPresent = false;
    let lastCreate: ObjectNotification | undefined;
    let lastDelete: ObjectNotification | undefined;
    let lastNotification: ObjectNotification | undefined;
    let stateVersion: string | undefined;
    let lastModified: number | undefined;
    let presenceSince: number | undefined;
    let establishingCreates: ObjectNotification[] = [];
    let previousSnapshot: NormalizedSnapshot | undefined;
    let previousPresent = false;
    let lastSnapshot: NormalizedSnapshot | undefined;
    const corrections: Correction[] = [];

    const applyEvent = (event: ObjectNotification): void => {
      lastNotification = event;
      known = true;
      if (event.operation === "create") {
        lastCreate = event;
        lastKnownPresent = true;
        const visibleFrom = Math.max(
          event.eventTime,
          event.readableAfter ?? event.eventTime,
        );
        if (!exists) {
          exists = true;
          presenceSince = visibleFrom;
          establishingCreates = [event];
          stateVersion = event.version;
          lastModified = undefined;
        } else {
          establishingCreates.push(event);
          if (presenceSince === undefined || visibleFrom < presenceSince) {
            presenceSince = visibleFrom;
          }
          if (event.version !== undefined) stateVersion = event.version;
        }
      } else {
        lastDelete = event;
        lastKnownPresent = false;
        exists = false;
        presenceSince = undefined;
        establishingCreates = [];
        stateVersion = undefined;
        lastModified = undefined;
      }
    };

    for (const snapshot of snapshots) {
      const consumed: ObjectNotification[] = [];
      while (
        eventIndex < events.length &&
        this.#covers(events[eventIndex]!.eventTime, snapshot.boundary)
      ) {
        const event = events[eventIndex]!;
        consumed.push(event);
        applyEvent(event);
        eventIndex += 1;
      }

      const entry = snapshot.byKey.get(key);
      const present = entry !== undefined;

      if (exists && !present) {
        const visibilityDecided =
          presenceSince === undefined ||
          this.#reaches(snapshot.boundary, presenceSince);
        if (visibilityDecided) {
          corrections.push(
            this.#makeCorrection(
              "delete",
              key,
              snapshot,
              previousSnapshot,
              previousPresent,
              consumed,
              lastCreate,
            ),
          );
          exists = false;
          lastKnownPresent = false;
          presenceSince = undefined;
          establishingCreates = [];
          stateVersion = undefined;
          lastModified = undefined;
        }
      } else if (!exists && present) {
        const restore =
          known && !lastKnownPresent
            ? true
            : consumed.length > 0 &&
              consumed[consumed.length - 1]!.operation === "delete";
        corrections.push(
          this.#makeCorrection(
            restore ? "restore" : "create",
            key,
            snapshot,
            previousSnapshot,
            previousPresent,
            consumed,
            lastDelete,
          ),
        );
        known = true;
        exists = true;
        lastKnownPresent = true;
        presenceSince = snapshot.boundary;
        establishingCreates = [];
        stateVersion = entry.version;
        lastModified = entry.lastModified;
      } else if (exists && present) {
        known = true;
        lastKnownPresent = true;
        establishingCreates = [];
        if (
          presenceSince === undefined ||
          snapshot.boundary < presenceSince
        ) {
          presenceSince = snapshot.boundary;
        }
        if (entry.version !== undefined) stateVersion = entry.version;
        if (entry.lastModified !== undefined) {
          lastModified = entry.lastModified;
        }
      } else {
        establishingCreates = [];
        stateVersion = undefined;
        lastModified = undefined;
      }

      previousSnapshot = snapshot;
      previousPresent = present;
      lastSnapshot = snapshot;
    }

    const trailing = events.slice(eventIndex);
    for (const event of trailing) applyEvent(event);

    let pendingReason: PendingReason | undefined;
    let pendingNotifications: ObjectNotification[] = [];

    if (snapshots.length === 0) {
      if (events.length > 0) {
        pendingReason = "no-snapshot";
        pendingNotifications = events.slice();
      }
    } else if (trailing.length > 0) {
      pendingReason = "newer-than-snapshot";
      pendingNotifications = [...establishingCreates, ...trailing];
    } else if (
      exists &&
      presenceSince !== undefined &&
      lastSnapshot !== undefined &&
      !this.#reaches(lastSnapshot.boundary, presenceSince)
    ) {
      pendingReason = "awaiting-visibility";
      pendingNotifications = establishingCreates.slice();
    }

    const uniquePending = uniqueSortedNotifications(pendingNotifications);
    let pending: PendingObject | undefined;
    if (pendingReason !== undefined && uniquePending.length > 0) {
      const newest = uniquePending[uniquePending.length - 1]!;
      pending = {
        key,
        exists,
        reason: pendingReason,
        notification: cloneNotification(newest),
        notifications: uniquePending,
      };
      if (lastSnapshot !== undefined) {
        pending.lastSnapshotId = lastSnapshot.snapshotId;
        pending.lastSnapshotBoundary = lastSnapshot.boundary;
      }
    }

    const object: ReconciledObject = {
      key,
      exists,
      pending: pending !== undefined,
    };
    if (stateVersion !== undefined) object.version = stateVersion;
    if (lastModified !== undefined) object.lastModified = lastModified;
    if (lastNotification !== undefined) {
      object.lastEventId = lastNotification.eventId;
      object.lastEventTime = lastNotification.eventTime;
      object.lastOperation = lastNotification.operation;
    }
    if (lastSnapshot !== undefined) {
      object.lastSnapshotId = lastSnapshot.snapshotId;
      object.lastSnapshotBoundary = lastSnapshot.boundary;
    }

    return { object, corrections, pending };
  }

  #makeCorrection(
    type: CorrectionType,
    key: string,
    snapshot: NormalizedSnapshot,
    previousSnapshot: NormalizedSnapshot | undefined,
    previousPresent: boolean,
    primaryNotifications: readonly ObjectNotification[],
    fallbackNotification: ObjectNotification | undefined,
  ): Correction {
    const entry = snapshot.byKey.get(key);
    const observedPresent = entry !== undefined;

    const relevant = [...primaryNotifications];
    if (type === "delete" || type === "restore") {
      if (fallbackNotification !== undefined) {
        relevant.push(fallbackNotification);
      }
    }

    const evidenceSnapshots: InventoryEvidence[] = [];
    if (
      previousSnapshot !== undefined &&
      previousSnapshot.snapshotId !== snapshot.snapshotId &&
      previousPresent !== observedPresent
    ) {
      evidenceSnapshots.push(
        this.#snapshotEvidence(previousSnapshot, key, previousPresent),
      );
    }
    evidenceSnapshots.push(
      this.#snapshotEvidence(snapshot, key, observedPresent),
    );

    const expectedPresent = type === "delete";
    let reason: CorrectionReason;
    let message: string;
    if (type === "delete") {
      reason = "missing-from-snapshot";
      message =
        "object was present according to covered notifications but is missing " +
        "from the inventory snapshot";
    } else if (type === "restore") {
      reason = "snapshot-contradicts-delete";
      message =
        "object is listed in the inventory snapshot although a covered " +
        "notification deleted it";
    } else {
      reason = "snapshot-only-object";
      message =
        "object is listed in the inventory snapshot without a matching " +
        "notification";
    }

    return {
      id: `correction:${snapshot.snapshotId}:${type}:${key}`,
      type,
      reason,
      key,
      at: snapshot.boundary,
      snapshotId: snapshot.snapshotId,
      expected: expectedPresent ? "present" : "absent",
      observed: observedPresent ? "present" : "absent",
      action: type === "delete" ? "delete" : "upsert",
      message,
      evidence: {
        notifications: uniqueSortedNotifications(relevant),
        snapshots: evidenceSnapshots,
      },
    };
  }

  #snapshotEvidence(
    snapshot: NormalizedSnapshot,
    key: string,
    present: boolean,
  ): InventoryEvidence {
    const evidence: InventoryEvidence = {
      snapshotId: snapshot.snapshotId,
      boundary: snapshot.boundary,
      present,
    };
    if (snapshot.capturedAt !== undefined) {
      evidence.capturedAt = snapshot.capturedAt;
    }
    if (present) {
      const entry = snapshot.byKey.get(key);
      if (entry !== undefined) {
        evidence.entry = cloneInventoryObject(entry);
      }
    }
    return evidence;
  }
}

/** Builds a reconciler, ingests both fact streams, and reconciles them. */
export function reconcile(
  notifications: Iterable<ObjectNotification> = [],
  snapshots: Iterable<InventorySnapshot> = [],
  options: ReconcilerOptions = {},
): ReconciliationResult {
  const reconciler = new ObjectReconciler(options);
  reconciler.ingestNotifications(notifications);
  reconciler.ingestSnapshots(snapshots);
  return reconciler.reconcile();
}

export function createReconciler(
  options: ReconcilerOptions = {},
): ObjectReconciler {
  return new ObjectReconciler(options);
}

export { ObjectReconciler as Reconciler };
export default ObjectReconciler;
