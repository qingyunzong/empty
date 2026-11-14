/**
 * Incremental foreign-key state tracking.
 *
 * The component is deliberately event-sourced: every append-only fact that
 * influences validation is recorded in `history`.  In particular, a violation
 * which has been finalized by a closed window is never rewritten.  If its
 * parent arrives later, that is recorded as a new repair event and the
 * historical violation remains queryable.
 */

export type ForeignKeyKey = string | number | bigint;

export type ChangeOperation = "upsert" | "delete";

export interface ParentChange {
  type?: string;
  op?: string;
  action?: string;
  entity?: "parent";
  key?: ForeignKeyKey;
  id?: ForeignKeyKey;
  parent_key?: ForeignKeyKey;
  parent_id?: ForeignKeyKey;
  parentKey?: ForeignKeyKey;
  parentId?: ForeignKeyKey;
  parentID?: ForeignKeyKey;
  pk?: ForeignKeyKey;
  version?: number;
  at?: number;
  rowVersion?: number;
  ts?: number;
  timestamp?: number;
  eventTime?: number;
  watermark?: number;
  data?: unknown;
  row?: Record<string, unknown>;
  deleted?: boolean;
}

export interface ChildChange {
  type?: string;
  op?: string;
  action?: string;
  entity?: "child";
  key?: ForeignKeyKey;
  id?: ForeignKeyKey;
  child_key?: ForeignKeyKey;
  child_id?: ForeignKeyKey;
  childKey?: ForeignKeyKey;
  childId?: ForeignKeyKey;
  childID?: ForeignKeyKey;
  ck?: ForeignKeyKey;
  parent?: ForeignKeyKey | null;
  parent_key?: ForeignKeyKey | null;
  parent_id?: ForeignKeyKey | null;
  parentKey?: ForeignKeyKey | null;
  parentId?: ForeignKeyKey | null;
  parentID?: ForeignKeyKey | null;
  references?: ForeignKeyKey | null;
  ref?: ForeignKeyKey | null;
  fk?: ForeignKeyKey | null;
  fkId?: ForeignKeyKey | null;
  foreignKey?: ForeignKeyKey | null;
  version?: number;
  at?: number;
  rowVersion?: number;
  ts?: number;
  timestamp?: number;
  eventTime?: number;
  watermark?: number;
  deadline?: number;
  dueAt?: number;
  due?: number;
  expiresAt?: number;
  expireAt?: number;
  cutoff?: number;
  deadlineWatermark?: number;
  data?: unknown;
  row?: Record<string, unknown>;
  deleted?: boolean;
}

export type StateChange =
  | (ParentChange & { entity: "parent" })
  | (ChildChange & { entity: "child" });

export interface ForeignKeyStateOptions {
  /** Number of logical time units a missing parent may be pending. */
  window?: number;
  /** Alias for `window`. */
  windowSize?: number;
  /** Alias for `window`. */
  grace?: number;
  /** Alias for `window`. */
  gracePeriod?: number;
  /** Alias for `window`. */
  pendingWindow?: number;
  /** Alias for `window`. */
  delay?: number;
  /** Initial watermark. */
  watermark?: number;
  /** Alias for `watermark`. */
  initialWatermark?: number;
  /** Initial logical version. */
  version?: number;
  /** Alias for `version`. */
  initialVersion?: number;
  /** Start with the validation window already closed. */
  closed?: boolean;
}

export interface PendingReference {
  childKey: string;
  parentKey: string;
  childVersion: number;
  openedAt: number;
  deadline: number;
  /** Alias for `deadline`, using the domain wording. */
  deadlineWatermark: number;
  status: "pending";
}

export type ViolationReason = "missing-parent" | "parent-deleted";

export type ViolationStatus = "open" | "resolved";

export interface FinalViolation {
  id: string;
  childKey: string;
  parentKey: string;
  /** Version of the child row that violated the constraint. */
  childVersion: number;
  /** Alias for `childVersion`. */
  violatingVersion: number;
  /** The version at which this violation became final. */
  version: number;
  finalizedVersion: number;
  /** Alias for `finalizedVersion`. */
  finalVersion: number;
  /** The deadline (or explicit parent deletion version) that caused closure. */
  detectedVersion: number;
  reason: ViolationReason;
  deadline?: number;
  /** Version of the parent deletion, when `reason` is `parent-deleted`. */
  parentVersion?: number;
  status: ViolationStatus;
  resolvedVersion?: number;
  resolvedBy?: string;
  resolutionEventId?: number;
}

export interface GetViolationOptions {
  /** Defaults to `true`: finalized violations are history and stay visible. */
  includeResolved?: boolean;
  /** Alias for `includeResolved: false`. */
  activeOnly?: boolean;
}

export type Violation = FinalViolation;
export type ViolationRecord = FinalViolation;
export type Pending = PendingReference;
export type ForeignKeyOptions = ForeignKeyStateOptions;
export type Change = StateChange;

export type HistoryEventKind =
  | "parent-upsert"
  | "parent-delete"
  | "child-upsert"
  | "child-delete"
  | "pending"
  | "pending-refresh"
  | "pending-revoked"
  | "violation"
  | "repair"
  | "resolution"
  | "watermark"
  | "window-closed"
  | "stale";

export interface HistoryEvent {
  seq: number;
  kind: HistoryEventKind;
  /** Alias for `kind`, useful for generic event consumers. */
  type: HistoryEventKind;
  version: number;
  childKey?: string;
  parentKey?: string;
  violationId?: string;
  reason?: string;
  deadline?: number;
  /** The version supplied by the incoming change, before repair stamping. */
  arrivalVersion?: number;
  details?: Record<string, unknown>;
}

export interface ParentState {
  key: string;
  version: number;
  deleted: boolean;
  data?: unknown;
}

export interface ChildState {
  key: string;
  parentKey: string | null;
  version: number;
  data?: unknown;
  status: "satisfied" | "pending" | "violation";
}

export interface ForeignKeySnapshot {
  version: number;
  watermark: number;
  closed: boolean;
  parents: ParentState[];
  children: ChildState[];
  pending: PendingReference[];
  violations: FinalViolation[];
  activeViolations: FinalViolation[];
  history: HistoryEvent[];
}

interface ParentEntry {
  key: string;
  version: number;
  deleted: boolean;
  data?: unknown;
}

interface ChildEntry {
  key: string;
  parentKey: string | null;
  version: number;
  data?: unknown;
}

interface PendingEntry {
  childKey: string;
  parentKey: string;
  childVersion: number;
  openedAt: number;
  deadline: number;
}

interface ViolationEntry {
  id: string;
  childKey: string;
  parentKey: string;
  childVersion: number;
  reason: ViolationReason;
  deadline?: number;
  detectedVersion: number;
  finalizedVersion: number;
  parentVersion?: number;
}

interface ResolutionEntry {
  version: number;
  reason: string;
  eventId: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function asKey(value: unknown, what: string): string {
  if (value === undefined || value === null) {
    throw new TypeError(`${what} is required`);
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new TypeError(`${what} must be a string, number, or bigint`);
}

function readKey(change: UnknownRecord, names: string[]): unknown {
  for (const name of names) {
    if (change[name] !== undefined) return change[name];
  }
  const row = isRecord(change.row) ? change.row : undefined;
  if (row) {
    for (const name of names) {
      if (row[name] !== undefined) return row[name];
    }
  }
  const data = isRecord(change.data) ? change.data : undefined;
  if (data) {
    for (const name of names) {
      if (data[name] !== undefined) return data[name];
    }
  }
  return undefined;
}

function readVersion(change: UnknownRecord): number | undefined {
  const row = isRecord(change.row) ? change.row : undefined;
  const data = isRecord(change.data) ? change.data : undefined;
  const raw = firstDefined(
    change.version,
    change.at,
    change.rowVersion,
    change.ts,
    change.timestamp,
    change.eventTime,
    change.watermark,
    row?.version,
    row?.at,
    row?.rowVersion,
    row?.timestamp,
    data?.version,
    data?.at,
    data?.rowVersion,
    data?.timestamp,
  );
  if (raw === undefined) return undefined;
  return normalizeNonNegative(raw, "version");
}

function readDeadline(change: UnknownRecord): number | undefined {
  const row = isRecord(change.row) ? change.row : undefined;
  const data = isRecord(change.data) ? change.data : undefined;
  const raw = firstDefined(
    change.deadline,
    change.dueAt,
    change.due,
    change.expiresAt,
    change.expireAt,
    change.cutoff,
    change.deadlineWatermark,
    row?.deadline,
    row?.dueAt,
    row?.deadlineWatermark,
    data?.deadline,
    data?.dueAt,
    data?.deadlineWatermark,
  );
  if (raw === undefined) return undefined;
  return normalizeNonNegative(raw, "deadline");
}

function normalizeNonNegative(value: unknown, what: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${what} must be a number`);
  }
  if (value < 0) {
    throw new RangeError(`${what} must be non-negative`);
  }
  return value;
}

function normalizeWindow(value: unknown, what: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${what} must be a number`);
  }
  if (value < 0) {
    throw new RangeError(`${what} must be non-negative`);
  }
  return value;
}

function operationOf(change: UnknownRecord): ChangeOperation {
  const raw = String(
    firstDefined(change.op, change.type, change.action, "") ?? "",
  ).toLowerCase();
  const row = isRecord(change.row) ? change.row : undefined;
  const data = isRecord(change.data) ? change.data : undefined;
  if (
    change.deleted === true ||
    row?.deleted === true ||
    data?.deleted === true ||
    raw.includes("delete") ||
    raw.includes("remove") ||
    raw === "del" ||
    raw === "rm"
  ) {
    return "delete";
  }
  return "upsert";
}

function entityOf(change: UnknownRecord): "parent" | "child" {
  const entity = String(change.entity ?? "").toLowerCase();
  if (entity === "parent" || entity === "parents") return "parent";
  if (entity === "child" || entity === "children") return "child";

  const kind = String(
    firstDefined(change.kind, change.type, change.op, change.action, "") ?? "",
  ).toLowerCase();
  if (kind.startsWith("parent")) return "parent";
  if (kind.startsWith("child")) return "child";

  if (
    change.childKey !== undefined ||
    change.childId !== undefined ||
    change.references !== undefined ||
    change.ref !== undefined ||
    change.foreignKey !== undefined
  ) {
    return "child";
  }
  throw new TypeError(
    "change entity is required (expected 'parent' or 'child')",
  );
}

export class ForeignKeyState {
  private readonly window: number;
  private readonly parents = new Map<string, ParentEntry>();
  private readonly children = new Map<string, ChildEntry>();
  private readonly pendingByChild = new Map<string, PendingEntry>();
  private readonly violationById = new Map<string, ViolationEntry>();
  private readonly activeViolationByChild = new Map<string, string>();
  private readonly resolutionByViolation = new Map<
    string,
    ResolutionEntry
  >();
  private readonly events: HistoryEvent[] = [];

  private watermarkValue: number;
  private versionValue: number;
  private closedValue: boolean;
  private sequence = 0;
  private violationSequence = 0;

  constructor(options?: ForeignKeyStateOptions);
  constructor(window: number, watermark?: number);
  constructor(
    options: ForeignKeyStateOptions | number = {},
    positionalWatermark?: number,
  ) {
    const opts: ForeignKeyStateOptions =
      typeof options === "number"
        ? { window: options, watermark: positionalWatermark }
        : options;
    const configuredWindow = firstDefined(
      opts.window,
      opts.windowSize,
      opts.grace,
      opts.gracePeriod,
      opts.pendingWindow,
      opts.delay,
      0,
    );
    this.window = normalizeWindow(configuredWindow, "window");
    this.watermarkValue = normalizeNonNegative(
      firstDefined(opts.watermark, opts.initialWatermark, 0),
      "watermark",
    );
    this.versionValue = normalizeNonNegative(
      firstDefined(opts.version, opts.initialVersion, 0),
      "version",
    );
    this.closedValue = opts.closed === true;
  }

  // ---------------------------------------------------------------- changes

  apply(change: StateChange | (ParentChange | ChildChange)): boolean {
    if (!isRecord(change)) {
      throw new TypeError("change must be an object");
    }
    const event = change as UnknownRecord;
    return entityOf(event) === "parent"
      ? this.applyParent(event as ParentChange)
      : this.applyChild(event as ChildChange);
  }

  applyMany(changes: Array<StateChange | ParentChange | ChildChange>): number {
    let applied = 0;
    for (const change of changes) {
      if (this.apply(change)) applied += 1;
    }
    return applied;
  }

  applyParent(change: ParentChange): boolean {
    if (!isRecord(change)) throw new TypeError("parent change must be an object");
    const event = change as UnknownRecord;
    const key = asKey(
      readKey(event, [
        "key",
        "id",
        "parentKey",
        "parentId",
        "parent_key",
        "parent_id",
        "parentID",
        "pk",
        "parent",
      ]),
      "parent key",
    );
    const version = this.resolveVersion(readVersion(event));
    if (operationOf(event) === "delete") {
      return this.deleteParentAt(key, version);
    }
    const data = firstDefined(event.data, event.row);
    return this.upsertParentAt(key, version, data);
  }

  applyChild(change: ChildChange): boolean {
    if (!isRecord(change)) throw new TypeError("child change must be an object");
    const event = change as UnknownRecord;
    const key = asKey(
      readKey(event, [
        "key",
        "id",
        "childKey",
        "childId",
        "child_key",
        "child_id",
        "childID",
        "ck",
        "child",
      ]),
      "child key",
    );
    const version = this.resolveVersion(readVersion(event));
    if (operationOf(event) === "delete") {
      return this.deleteChildAt(key, version);
    }

    const rawParent = readKey(event, [
      "parentKey",
      "parentId",
      "parent_key",
      "parent_id",
      "parentID",
      "parent",
      "references",
      "ref",
      "fk",
      "fkId",
      "foreignKey",
    ]);
    if (rawParent === undefined) {
      throw new TypeError("child parent key is required (or pass null)");
    }
    const parentKey = rawParent === null ? null : asKey(rawParent, "parent key");
    const deadline = readDeadline(event);
    const data = firstDefined(event.data, event.row);
    return this.upsertChildAt(key, parentKey, version, data, deadline);
  }

  parentChange(change: ParentChange): boolean {
    return this.applyParent(change);
  }

  applyParentChange(change: ParentChange): boolean {
    return this.applyParent(change);
  }

  childChange(change: ChildChange): boolean {
    return this.applyChild(change);
  }

  applyChildChange(change: ChildChange): boolean {
    return this.applyChild(change);
  }

  upsertParent(
    changeOrKey: ParentChange | ForeignKeyKey,
    version?: number,
    data?: unknown,
  ): boolean {
    if (isRecord(changeOrKey)) {
      return this.applyParent({ ...changeOrKey, type: "upsert" });
    }
    return this.upsertParentAt(
      asKey(changeOrKey, "parent key"),
      this.resolveVersion(version),
      data,
    );
  }

  insertParent = this.upsertParent.bind(this);
  addParent = this.upsertParent.bind(this);
  updateParent = this.upsertParent.bind(this);

  trackParent(change: ParentChange): boolean;
  trackParent(
    key: ForeignKeyKey,
    version?: number,
    data?: unknown,
  ): boolean;
  trackParent(
    changeOrKey: ParentChange | ForeignKeyKey,
    version?: number,
    data?: unknown,
  ): boolean {
    return isRecord(changeOrKey)
      ? this.applyParent(changeOrKey)
      : this.upsertParent(changeOrKey, version, data);
  }

  onParent = this.trackParent.bind(this);
  receiveParent = this.trackParent.bind(this);

  deleteParent(
    changeOrKey: ParentChange | ForeignKeyKey,
    version?: number,
  ): boolean {
    if (isRecord(changeOrKey)) {
      return this.applyParent({ ...changeOrKey, type: "delete" });
    }
    return this.deleteParentAt(
      asKey(changeOrKey, "parent key"),
      this.resolveVersion(version),
    );
  }

  removeParent = this.deleteParent.bind(this);
  dropParent = this.deleteParent.bind(this);

  upsertChild(
    changeOrKey: ChildChange | ForeignKeyKey,
    parentKey?: ForeignKeyKey | null,
    version?: number,
    data?: unknown,
    deadline?: number,
  ): boolean {
    if (isRecord(changeOrKey)) {
      return this.applyChild({ ...changeOrKey, type: "upsert" });
    }
    return this.upsertChildAt(
      asKey(changeOrKey, "child key"),
      parentKey === null || parentKey === undefined
        ? null
        : asKey(parentKey, "parent key"),
      this.resolveVersion(version),
      data,
      deadline,
    );
  }

  insertChild = this.upsertChild.bind(this);
  addChild = this.upsertChild.bind(this);
  updateChild = this.upsertChild.bind(this);

  trackChild(change: ChildChange): boolean;
  trackChild(
    key: ForeignKeyKey,
    parentKey: ForeignKeyKey | null,
    version?: number,
    data?: unknown,
    deadline?: number,
  ): boolean;
  trackChild(
    changeOrKey: ChildChange | ForeignKeyKey,
    parentKey?: ForeignKeyKey | null,
    version?: number,
    data?: unknown,
    deadline?: number,
  ): boolean {
    return isRecord(changeOrKey)
      ? this.applyChild(changeOrKey)
      : this.upsertChild(
          changeOrKey,
          parentKey,
          version,
          data,
          deadline,
        );
  }

  onChild = this.trackChild.bind(this);
  receiveChild = this.trackChild.bind(this);

  deleteChild(
    changeOrKey: ChildChange | ForeignKeyKey,
    version?: number,
  ): boolean {
    if (isRecord(changeOrKey)) {
      return this.applyChild({ ...changeOrKey, type: "delete" });
    }
    return this.deleteChildAt(
      asKey(changeOrKey, "child key"),
      this.resolveVersion(version),
    );
  }

  removeChild = this.deleteChild.bind(this);
  dropChild = this.deleteChild.bind(this);

  // -------------------------------------------------------------- watermarks

  /**
   * Advance the monotonic watermark.  Every pending reference whose deadline
   * is at or below the new watermark becomes a finalized violation.
   *
   * Returns only the violations finalized by this call.
   */
  advanceWatermark(watermark: number): FinalViolation[] {
    const next = normalizeNonNegative(watermark, "watermark");
    if (next < this.watermarkValue) {
      throw new RangeError(
        `watermark cannot move backwards (current ${this.watermarkValue}, next ${next})`,
      );
    }
    this.watermarkValue = next;
    this.log("watermark", { version: next });

    const finalized: ViolationEntry[] = [];
    for (const pending of [...this.pendingByChild.values()]) {
      if (pending.deadline <= next) {
        const violation = this.finalizePending(pending, {
          reason: "missing-parent",
          detectedVersion: pending.deadline,
          finalizedVersion: next,
        });
        finalized.push(violation);
      }
    }
    return finalized.map((violation) => this.toFinalViolation(violation));
  }

  advance(watermark: number): FinalViolation[] {
    return this.advanceWatermark(watermark);
  }

  advanceTo(watermark: number): FinalViolation[] {
    return this.advanceWatermark(watermark);
  }

  setWatermark(watermark: number): FinalViolation[] {
    return this.advanceWatermark(watermark);
  }

  /**
   * Close the window.  All still-pending references are finalized at the
   * closure watermark, even if their own deadline is later.  Future missing
   * parents are violations immediately.
   *
   * The complete finalized violation history is returned.  Calling this more
   * than once is idempotent with respect to already finalized history.
   */
  closeWindow(watermark?: number): FinalViolation[] {
    if (watermark !== undefined) {
      const next = normalizeNonNegative(watermark, "watermark");
      if (next < this.watermarkValue) {
        throw new RangeError(
          `watermark cannot move backwards (current ${this.watermarkValue}, next ${next})`,
        );
      }
      this.watermarkValue = next;
    }
    this.closedValue = true;

    const closureVersion = this.watermarkValue;
    for (const pending of [...this.pendingByChild.values()]) {
      this.finalizePending(pending, {
        reason: "missing-parent",
        detectedVersion: pending.deadline,
        finalizedVersion: Math.max(
          closureVersion,
          pending.childVersion,
        ),
      });
    }
    this.log("window-closed", {
      version: closureVersion,
      details: { violationCount: this.violationById.size },
    });
    return this.getViolations({ includeResolved: true });
  }

  close = this.closeWindow.bind(this);
  finalize = this.closeWindow.bind(this);
  finalizeWindow = this.closeWindow.bind(this);

  // ----------------------------------------------------------------- queries

  getPending(): PendingReference[] {
    return [...this.pendingByChild.values()]
      .sort((a, b) => {
        if (a.deadline !== b.deadline) return a.deadline - b.deadline;
        return a.childKey.localeCompare(b.childKey);
      })
      .map((pending) => ({
        childKey: pending.childKey,
        parentKey: pending.parentKey,
        childVersion: pending.childVersion,
        openedAt: pending.openedAt,
        deadline: pending.deadline,
        deadlineWatermark: pending.deadline,
        status: "pending" as const,
      }));
  }

  get pending(): PendingReference[] {
    return this.getPending();
  }

  getPendingCount(): number {
    return this.pendingByChild.size;
  }

  get pendingCount(): number {
    return this.pendingByChild.size;
  }

  getPendingReferences(): PendingReference[] {
    return this.getPending();
  }

  get pendingReferences(): PendingReference[] {
    return this.getPending();
  }

  getViolations(options: GetViolationOptions = {}): FinalViolation[] {
    const includeResolved =
      options.activeOnly === true
        ? false
        : options.includeResolved !== false;
    return [...this.violationById.values()]
      .sort((a, b) => {
        if (a.finalizedVersion !== b.finalizedVersion) {
          return a.finalizedVersion - b.finalizedVersion;
        }
        return a.id.localeCompare(b.id);
      })
      .map((violation) => this.toFinalViolation(violation))
      .filter(
        (violation) => includeResolved || violation.status === "open",
      );
  }

  get violations(): FinalViolation[] {
    return this.getViolations();
  }

  get finalViolations(): FinalViolation[] {
    return this.getViolations({ includeResolved: true });
  }

  getViolationCount(options: GetViolationOptions = {}): number {
    return this.getViolations(options).length;
  }

  get violationCount(): number {
    return this.violationById.size;
  }

  getActiveViolationCount(): number {
    return this.activeViolationByChild.size;
  }

  get activeViolationCount(): number {
    return this.activeViolationByChild.size;
  }

  getFinalViolationVersions(options: GetViolationOptions = {}): number[] {
    return this.getViolations(options).map((violation) => violation.version);
  }

  get finalViolationVersions(): number[] {
    return this.getFinalViolationVersions();
  }

  getFinalViolationVersion(): number | undefined {
    let latest: number | undefined;
    for (const violation of this.violationById.values()) {
      if (latest === undefined || violation.finalizedVersion > latest) {
        latest = violation.finalizedVersion;
      }
    }
    return latest;
  }

  get finalViolationVersion(): number | undefined {
    return this.getFinalViolationVersion();
  }

  getActiveViolations(): FinalViolation[] {
    return this.getViolations({ includeResolved: false });
  }

  get activeViolations(): FinalViolation[] {
    return this.getActiveViolations();
  }

  getFinalViolations(): FinalViolation[] {
    return this.getViolations({ includeResolved: true });
  }

  getViolation(id: string): FinalViolation | undefined {
    const violation = this.violationById.get(id);
    return violation ? this.toFinalViolation(violation) : undefined;
  }

  getHistory(): HistoryEvent[] {
    return this.events.map((event) => ({
      ...event,
      ...(event.details ? { details: { ...event.details } } : {}),
    }));
  }

  getEvents(): HistoryEvent[] {
    return this.getHistory();
  }

  getEventLog(): HistoryEvent[] {
    return this.getHistory();
  }

  get history(): HistoryEvent[] {
    return this.getHistory();
  }

  getWatermark(): number {
    return this.watermarkValue;
  }

  get watermark(): number {
    return this.watermarkValue;
  }

  getVersion(): number {
    return this.versionValue;
  }

  get version(): number {
    return this.versionValue;
  }

  isClosed(): boolean {
    return this.closedValue;
  }

  get closed(): boolean {
    return this.closedValue;
  }

  snapshot(): ForeignKeySnapshot {
    return {
      version: this.versionValue,
      watermark: this.watermarkValue,
      closed: this.closedValue,
      parents: [...this.parents.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((parent) => ({ ...parent })),
      children: [...this.children.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((child) => ({
          ...child,
          status: this.childStatus(child.key),
        })),
      pending: this.getPending(),
      violations: this.getViolations({ includeResolved: true }),
      activeViolations: this.getViolations({ includeResolved: false }),
      history: this.getHistory(),
    };
  }

  getSnapshot(): ForeignKeySnapshot {
    return this.snapshot();
  }

  toJSON(): ForeignKeySnapshot {
    return this.snapshot();
  }

  // ------------------------------------------------------------- internals

  private resolveVersion(explicit: number | undefined): number {
    if (explicit !== undefined) {
      const version = normalizeNonNegative(explicit, "version");
      this.noteVersion(version);
      return version;
    }
    const version = Math.max(this.versionValue, this.watermarkValue) + 1;
    this.versionValue = version;
    return version;
  }

  private noteVersion(version: number): void {
    if (version > this.versionValue) this.versionValue = version;
  }

  private upsertParentAt(
    key: string,
    version: number,
    data?: unknown,
  ): boolean {
    this.noteVersion(version);
    const existing = this.parents.get(key);
    if (existing && version < existing.version) {
      this.log("stale", {
        version,
        parentKey: key,
        reason: "older-parent-version",
        details: { currentVersion: existing.version },
      });
      return false;
    }

    this.parents.set(key, {
      key,
      version,
      deleted: false,
      data,
    });
    this.log("parent-upsert", {
      version,
      parentKey: key,
      reason: existing?.deleted ? "restored" : undefined,
    });

    const repairVersion = Math.max(
      version,
      this.versionValue,
      this.watermarkValue,
    );

    for (const child of [...this.children.values()]) {
      if (child.parentKey !== key) continue;

      const pending = this.pendingByChild.get(child.key);
      if (pending) {
        this.pendingByChild.delete(child.key);
        this.log("pending-revoked", {
          version: Math.max(version, pending.openedAt),
          childKey: child.key,
          parentKey: key,
          reason: "parent-arrived",
          deadline: pending.deadline,
        });
      }

      const activeId = this.activeViolationByChild.get(child.key);
      if (activeId) {
        const violation = this.violationById.get(activeId);
        const repairedAt = Math.max(
          repairVersion,
          violation?.finalizedVersion ?? repairVersion,
        );
        this.resolveViolation(
          child.key,
          repairedAt,
          "parent-arrived",
          "repair",
          { arrivalVersion: version },
        );
      }
    }
    return true;
  }

  private deleteParentAt(key: string, version: number): boolean {
    this.noteVersion(version);
    const existing = this.parents.get(key);
    if (existing && version < existing.version) {
      this.log("stale", {
        version,
        parentKey: key,
        reason: "older-parent-version",
        details: { currentVersion: existing.version },
      });
      return false;
    }
    if (existing?.deleted && version === existing.version) {
      return false;
    }

    this.parents.set(key, {
      key,
      version,
      deleted: true,
      data: existing?.data,
    });
    this.log("parent-delete", { version, parentKey: key });

    for (const child of [...this.children.values()]) {
      if (child.parentKey !== key) continue;
      if (this.activeViolationByChild.has(child.key)) continue;
      const finalVersion = Math.max(
        version,
        child.version,
        this.watermarkValue,
      );

      const pending = this.pendingByChild.get(child.key);
      if (pending) {
        this.finalizePending(pending, {
          reason: "parent-deleted",
          detectedVersion: version,
          finalizedVersion: finalVersion,
          parentVersion: version,
        });
        continue;
      }

      this.createViolation({
        childKey: child.key,
        parentKey: key,
        childVersion: child.version,
        reason: "parent-deleted",
        detectedVersion: version,
        finalizedVersion: finalVersion,
        parentVersion: version,
      });
    }
    return true;
  }

  private upsertChildAt(
    key: string,
    parentKey: string | null,
    version: number,
    data?: unknown,
    explicitDeadline?: number,
  ): boolean {
    this.noteVersion(version);
    const existing = this.children.get(key);
    if (existing && version < existing.version) {
      this.log("stale", {
        version,
        childKey: key,
        reason: "older-child-version",
        details: { currentVersion: existing.version },
      });
      return false;
    }

    const oldParentKey = existing?.parentKey ?? null;
    const sameReference = existing !== undefined && oldParentKey === parentKey;

    if (existing && !sameReference) {
      this.clearChildCandidate(
        key,
        version,
        "child-updated",
      );
    }

    this.children.set(key, { key, parentKey, version, data });
    this.log("child-upsert", {
      version,
      childKey: key,
      parentKey: parentKey ?? undefined,
      reason: existing ? "updated" : "inserted",
    });

    if (parentKey === null) {
      this.clearChildCandidate(key, version, "no-reference");
      return true;
    }

    if (sameReference && this.activeViolationByChild.has(key)) {
      // A finalized violation is immutable.  A newer child version does not
      // erase it; the current relation is still violating its FK.
      return true;
    }

    if (sameReference && this.pendingByChild.has(key)) {
      const deadline = this.deadlineFor(parentKey, version, explicitDeadline);
      const pending = this.pendingByChild.get(key)!;
      pending.childVersion = version;
      pending.deadline = deadline;
      pending.openedAt = Math.max(pending.openedAt, version);
      this.log("pending-refresh", {
        version,
        childKey: key,
        parentKey,
        deadline,
      });
      if (deadline <= this.watermarkValue) {
        this.finalizePending(pending, {
          reason: "missing-parent",
          detectedVersion: deadline,
          finalizedVersion: this.watermarkValue,
        });
      }
      return true;
    }

    this.evaluateChildReference(key, parentKey, version, explicitDeadline);
    return true;
  }

  private deleteChildAt(key: string, version: number): boolean {
    this.noteVersion(version);
    const existing = this.children.get(key);
    if (!existing) {
      this.log("stale", {
        version,
        childKey: key,
        reason: "unknown-child",
      });
      return false;
    }
    if (version < existing.version) {
      this.log("stale", {
        version,
        childKey: key,
        reason: "older-child-version",
        details: { currentVersion: existing.version },
      });
      return false;
    }

    this.clearChildCandidate(key, version, "child-deleted");
    this.children.delete(key);
    this.log("child-delete", { version, childKey: key });
    return true;
  }

  private evaluateChildReference(
    childKey: string,
    parentKey: string,
    childVersion: number,
    explicitDeadline?: number,
  ): void {
    const parent = this.parents.get(parentKey);
    const parentExists = parent !== undefined && !parent.deleted;
    if (parentExists) {
      return;
    }

    if (parent?.deleted) {
      const finalizedVersion = Math.max(
        childVersion,
        parent.version,
        this.watermarkValue,
      );
      this.createViolation({
        childKey,
        parentKey,
        childVersion,
        reason: "parent-deleted",
        detectedVersion: parent.version,
        finalizedVersion,
        parentVersion: parent.version,
      });
      return;
    }

    const deadline = this.deadlineFor(
      parentKey,
      childVersion,
      explicitDeadline,
    );
    if (this.closedValue || deadline <= this.watermarkValue) {
      this.createViolation({
        childKey,
        parentKey,
        childVersion,
        reason: "missing-parent",
        deadline,
        detectedVersion: deadline,
        finalizedVersion: Math.max(childVersion, this.watermarkValue),
      });
      return;
    }

    this.pendingByChild.set(childKey, {
      childKey,
      parentKey,
      childVersion,
      openedAt: childVersion,
      deadline,
    });
    this.log("pending", {
      version: childVersion,
      childKey,
      parentKey,
      deadline,
      reason: "parent-missing",
    });
  }

  private deadlineFor(
    _parentKey: string,
    childVersion: number,
    explicitDeadline?: number,
  ): number {
    if (explicitDeadline !== undefined) {
      return normalizeNonNegative(explicitDeadline, "deadline");
    }
    return childVersion + this.window;
  }

  private clearChildCandidate(
    childKey: string,
    version: number,
    reason: string,
  ): void {
    const pending = this.pendingByChild.get(childKey);
    if (pending) {
      this.pendingByChild.delete(childKey);
      this.log("pending-revoked", {
        version,
        childKey,
        parentKey: pending.parentKey,
        deadline: pending.deadline,
        reason,
      });
    }
    if (this.activeViolationByChild.has(childKey)) {
      this.resolveViolation(childKey, version, reason, "resolution");
    }
  }

  private finalizePending(
    pending: PendingEntry,
    options: {
      reason: ViolationReason;
      detectedVersion: number;
      finalizedVersion: number;
      parentVersion?: number;
    },
  ): ViolationEntry {
    this.pendingByChild.delete(pending.childKey);
    return this.createViolation({
      childKey: pending.childKey,
      parentKey: pending.parentKey,
      childVersion: pending.childVersion,
      reason: options.reason,
      deadline: pending.deadline,
      detectedVersion: options.detectedVersion,
      finalizedVersion: options.finalizedVersion,
      parentVersion: options.parentVersion,
    });
  }

  private createViolation(input: {
    childKey: string;
    parentKey: string;
    childVersion: number;
    reason: ViolationReason;
    deadline?: number;
    detectedVersion: number;
    finalizedVersion: number;
    parentVersion?: number;
  }): ViolationEntry {
    const existingId = this.activeViolationByChild.get(input.childKey);
    if (existingId) {
      const existing = this.violationById.get(existingId);
      if (existing) return existing;
    }

    const id = `fk:${input.childKey}->${input.parentKey}#${++this.violationSequence}`;
    const violation: ViolationEntry = {
      id,
      childKey: input.childKey,
      parentKey: input.parentKey,
      childVersion: input.childVersion,
      reason: input.reason,
      deadline: input.deadline,
      detectedVersion: input.detectedVersion,
      finalizedVersion: input.finalizedVersion,
      parentVersion: input.parentVersion,
    };
    this.violationById.set(id, violation);
    this.activeViolationByChild.set(input.childKey, id);

    this.log("violation", {
      version: input.finalizedVersion,
      childKey: input.childKey,
      parentKey: input.parentKey,
      violationId: id,
      reason: input.reason,
      deadline: input.deadline,
      details: {
        childVersion: input.childVersion,
        detectedVersion: input.detectedVersion,
        parentVersion: input.parentVersion,
      },
    });
    return violation;
  }

  private resolveViolation(
    childKey: string,
    version: number,
    reason: string,
    kind: "repair" | "resolution",
    details?: Record<string, unknown>,
  ): void {
    const id = this.activeViolationByChild.get(childKey);
    if (!id) return;
    const violation = this.violationById.get(id);
    if (!violation) {
      this.activeViolationByChild.delete(childKey);
      return;
    }

    const effectiveVersion = Math.max(
      version,
      violation.finalizedVersion,
    );
    const event = this.log(kind, {
      version: effectiveVersion,
      childKey,
      parentKey: violation.parentKey,
      violationId: id,
      reason,
      details: {
        ...details,
        finalizedVersion: violation.finalizedVersion,
      },
    });
    this.resolutionByViolation.set(id, {
      version: effectiveVersion,
      reason,
      eventId: event.seq,
    });
    this.activeViolationByChild.delete(childKey);
  }

  private toFinalViolation(violation: ViolationEntry): FinalViolation {
    const resolution = this.resolutionByViolation.get(violation.id);
    return {
      id: violation.id,
      childKey: violation.childKey,
      parentKey: violation.parentKey,
      childVersion: violation.childVersion,
      violatingVersion: violation.childVersion,
      version: violation.finalizedVersion,
      finalizedVersion: violation.finalizedVersion,
      finalVersion: violation.finalizedVersion,
      detectedVersion: violation.detectedVersion,
      reason: violation.reason,
      ...(violation.deadline !== undefined
        ? { deadline: violation.deadline }
        : {}),
      ...(violation.parentVersion !== undefined
        ? { parentVersion: violation.parentVersion }
        : {}),
      status: resolution ? "resolved" : "open",
      ...(resolution
        ? {
            resolvedVersion: resolution.version,
            resolvedBy: resolution.reason,
            resolutionEventId: resolution.eventId,
          }
        : {}),
    };
  }

  private childStatus(childKey: string): ChildState["status"] {
    if (this.activeViolationByChild.has(childKey)) return "violation";
    if (this.pendingByChild.has(childKey)) return "pending";
    return "satisfied";
  }

  private log(
    kind: HistoryEventKind,
    fields: Omit<HistoryEvent, "seq" | "kind" | "type">,
  ): HistoryEvent {
    const event: HistoryEvent = {
      seq: ++this.sequence,
      kind,
      type: kind,
      ...fields,
    };
    this.events.push(event);
    return event;
  }
}

/** Conventional aliases keep the component easy to discover. */
export {
  ForeignKeyState as ForeignKeyTracker,
  ForeignKeyState as ForeignKeyValidator,
  ForeignKeyState as IncrementalForeignKeyState,
  ForeignKeyState as ForeignKeyStateMachine,
};

export function createForeignKeyState(
  options: ForeignKeyStateOptions = {},
): ForeignKeyState {
  return new ForeignKeyState(options);
}

export function createForeignKeyTracker(
  options: ForeignKeyStateOptions = {},
): ForeignKeyState {
  return new ForeignKeyState(options);
}

export function createForeignKeyValidator(
  options: ForeignKeyStateOptions = {},
): ForeignKeyState {
  return new ForeignKeyState(options);
}

export default ForeignKeyState;
