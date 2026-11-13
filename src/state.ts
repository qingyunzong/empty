import type {
  AcknowledgeResult,
  BatchControl,
  BatchKind,
  ChangeStreamEvent,
  ChangeStreamStateOptions,
  FullDocumentLookupEvidence,
  FullDocumentResolveOptions,
  GenerationReason,
  GenerationStatus,
  GenerationTransition,
  LookupSource,
  Namespace,
  NewGenerationOptions,
  OutputBatch,
  OutputEvent,
  PushOptions,
  SnapshotBeginOptions,
  SnapshotCompleteOptions,
  SnapshotGeneration,
  TransactionDescriptor,
} from "./types.ts";
import { resolveFullDocument } from "./lookup.ts";
import {
  cloneDate,
  cloneNamespace,
  HISTORY_LOST_ERROR_CODE,
  isHistoryLostError,
  isInvalidateEvent,
  isRenameEvent,
  namespaceKey,
  normalizeNamespace,
  normalizeTimestampMs,
  resumeTokenOf,
  sameNamespace,
  stableStringify,
  transactionKeyOf,
} from "./utils.ts";

interface InternalGeneration extends SnapshotGeneration {
  firstBatchId: number | null;
}

interface OpenTransaction {
  key: string;
  lsid: unknown;
  txnNumber: unknown;
  generation: number;
  token: unknown;
  events: OutputEvent[];
  startedAt: Date;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function batchIdOf(value: OutputBatch | number | string): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value.trim())) return null;
    return Number(value);
  }
  if (isRecord(value)) {
    const id = value.id ?? value.batchId;
    if (typeof id === "number" && Number.isSafeInteger(id)) return id;
    if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
  }
  return null;
}

/**
 * A resumable state machine for MongoDB change stream consumption.
 *
 * The central invariant is that an ingested resume token is never surfaced
 * as the committed token until the output batch that contains it has been
 * acknowledged.
 */
export class ChangeStreamState {
  static readonly HISTORY_LOST_ERROR_CODE = HISTORY_LOST_ERROR_CODE;
  static readonly isHistoryLostError = isHistoryLostError;
  static readonly transactionKeyOf = transactionKeyOf;

  private readonly clock: () => Date;
  private readonly autoFlushTransactions: boolean;
  private readonly idFactory?: (generation: number) => string;

  private _generationNumber = 1;
  private readonly _generations: InternalGeneration[] = [];
  private readonly _batches = new Map<number, OutputBatch>();
  private readonly _batchOrder: number[] = [];
  private _nextBatchId = 1;
  private readonly _openTransactions = new Map<string, OpenTransaction>();
  private readonly _namespaceMap = new Map<string, Namespace>();
  private _currentNamespace: Namespace | null = null;
  private _lastOutputBatch: OutputBatch | null = null;
  private _lastTransition: GenerationTransition | null = null;

  constructor(options: ChangeStreamStateOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.autoFlushTransactions = options.autoFlushTransactions ?? true;
    this.idFactory = options.idFactory;

    const startedAt = this.now();
    const resumeToken = options.resumeToken ?? null;
    const initial: InternalGeneration = {
      number: 1,
      id: this.makeGenerationId(1, "initial", startedAt),
      reason: "initial",
      status: "live",
      startedAt,
      snapshotStartedAt: null,
      completedAt: null,
      closedAt: null,
      entryResumeToken: resumeToken,
      resumeToken,
      tokenAtSnapshot: null,
      previousResumeToken: null,
      abandonedBatches: 0,
      committedBatches: 0,
      cause: null,
      firstBatchId: null,
    };
    this._generations.push(initial);
  }

  // ---------------------------------------------------------------------
  // Public state
  // ---------------------------------------------------------------------

  get generation(): number {
    return this._generationNumber;
  }

  get generationNumber(): number {
    return this._generationNumber;
  }

  get currentGeneration(): SnapshotGeneration {
    return this.cloneGeneration(this.currentInternal);
  }

  get snapshot(): SnapshotGeneration {
    return this.currentGeneration;
  }

  get snapshotGeneration(): SnapshotGeneration {
    return this.currentGeneration;
  }

  get generations(): readonly SnapshotGeneration[] {
    return this._generations.map((generation) =>
      this.cloneGeneration(generation),
    );
  }

  /** The committed token of the active generation. */
  get resumeToken(): unknown {
    return this.currentInternal.resumeToken;
  }

  get committedResumeToken(): unknown {
    return this.resumeToken;
  }

  get token(): unknown {
    return this.resumeToken;
  }

  get lastCommittedToken(): unknown {
    return this.resumeToken;
  }

  get hasResumeToken(): boolean {
    return this.resumeToken !== null;
  }

  get previousResumeToken(): unknown {
    return this.currentInternal.previousResumeToken;
  }

  get previousGenerationResumeToken(): unknown {
    return this.previousResumeToken;
  }

  /** Historical convenience only. Never use this as the active cursor. */
  get lastEverCommittedToken(): unknown {
    for (let index = this._generations.length - 1; index >= 0; index -= 1) {
      const token = this._generations[index].resumeToken;
      if (token !== null) return token;
    }
    return null;
  }

  get status(): GenerationStatus {
    return this.currentInternal.status;
  }

  get snapshotRequired(): boolean {
    return (
      this.status === "snapshot-required" || this.status === "snapshotting"
    );
  }

  get isSnapshotRequired(): boolean {
    return this.snapshotRequired;
  }

  get generationId(): string {
    return this.currentInternal.id;
  }

  get committedToken(): unknown {
    return this.resumeToken;
  }

  get invalidated(): boolean {
    return (
      this.status !== "live" &&
      (this.currentInternal.reason === "invalidate" ||
        this.currentInternal.reason === "history-lost")
    );
  }

  get invalidatedGeneration(): boolean {
    return this.currentInternal.reason === "invalidate";
  }

  get isInvalidated(): boolean {
    return this.invalidated;
  }

  get isHistoryLost(): boolean {
    return (
      this.status !== "live" &&
      this.currentInternal.reason === "history-lost"
    );
  }

  get historyLostGeneration(): boolean {
    return this.currentInternal.reason === "history-lost";
  }

  get currentNamespace(): Namespace | null {
    return cloneNamespace(this._currentNamespace);
  }

  get pendingBatchCount(): number {
    return this.pendingBatches.length;
  }

  get pendingBatches(): readonly OutputBatch[] {
    return this.currentGenerationBatches().filter(
      (batch) =>
        batch.status === "pending" || batch.status === "acknowledged",
    );
  }

  get lastOutputBatch(): OutputBatch | null {
    return this._lastOutputBatch;
  }

  get lastTransition(): GenerationTransition | null {
    return this._lastTransition;
  }

  get hasOpenTransactions(): boolean {
    return this._openTransactions.size > 0;
  }

  get openTransactionKeys(): readonly string[] {
    return [...this._openTransactions.keys()];
  }

  get pendingResumeToken(): unknown {
    let token: unknown = null;
    for (const batch of this.currentGenerationBatches()) {
      if (
        (batch.status === "pending" || batch.status === "acknowledged") &&
        batch.token !== null
      ) {
        token = batch.token;
      }
    }
    for (const transaction of this._openTransactions.values()) {
      if (transaction.token !== null) token = transaction.token;
    }
    return token;
  }

  getResumeToken(): unknown {
    return this.resumeToken;
  }

  getCommittedResumeToken(): unknown {
    return this.resumeToken;
  }

  getPendingResumeToken(): unknown {
    return this.pendingResumeToken;
  }

  get committedBatchIds(): readonly number[] {
    return this.currentGenerationBatches()
      .filter((batch) => batch.status === "committed")
      .map((batch) => batch.id);
  }

  get batches(): readonly OutputBatch[] {
    return this._batchOrder
      .map((id) => this._batches.get(id))
      .filter((batch): batch is OutputBatch => batch !== undefined);
  }

  get outputBatches(): readonly OutputBatch[] {
    return this.batches;
  }

  batch(id: number): OutputBatch | null {
    return this._batches.get(id) ?? null;
  }

  namespaceFor(namespace: Namespace | string | null): Namespace | null {
    return cloneNamespace(this.resolveNamespace(namespace));
  }

  transactionKey(event: ChangeStreamEvent): string | null {
    return transactionKeyOf(event);
  }

  // ---------------------------------------------------------------------
  // Ingest and output
  // ---------------------------------------------------------------------

  push(event: ChangeStreamEvent, options: PushOptions = {}): OutputBatch[] {
    this.assertEvent(event);

    if (isInvalidateEvent(event)) {
      return this.handleInvalidateEvent(event, options);
    }

    const token = resumeTokenOf(event);
    const transactionKey = transactionKeyOf(event);
    const ready: OutputBatch[] = [];

    if (transactionKey !== null) {
      if (this.autoFlushTransactions) {
        for (const key of this.openTransactionKeys) {
          if (key !== transactionKey) {
            ready.push(...this.flushTransaction(key));
          }
        }
      }

      let transaction = this._openTransactions.get(transactionKey);
      if (!transaction) {
        transaction = {
          key: transactionKey,
          lsid: event.lsid,
          txnNumber: event.txnNumber,
          generation: this._generationNumber,
          token,
          events: [],
          startedAt: this.now(),
        };
        this._openTransactions.set(transactionKey, transaction);
      }

      const descriptor: TransactionDescriptor = {
        key: transactionKey,
        lsid: event.lsid,
        txnNumber: event.txnNumber,
        sequence: transaction.events.length + 1,
        eventCount: transaction.events.length + 1,
      };
      const outputEvent = this.buildOutputEvent(
        event,
        descriptor,
        options.fullDocumentLookup,
      );
      transaction.events.push(outputEvent);
      transaction.token = token;
      for (const queued of transaction.events) {
        if (queued.transaction) {
          queued.transaction.eventCount = transaction.events.length;
        }
      }
      return ready;
    }

    if (this.autoFlushTransactions) {
      ready.push(...this.flush());
    }

    const outputEvent = this.buildOutputEvent(
      event,
      undefined,
      options.fullDocumentLookup,
    );
    const batch = this.recordBatch(
      this.createBatch("events", [outputEvent], token, null),
    );
    ready.push(batch);
    return ready;
  }

  ingest(event: ChangeStreamEvent, options: PushOptions = {}): OutputBatch[] {
    return this.push(event, options);
  }

  pushOne(
    event: ChangeStreamEvent,
    options: PushOptions = {},
  ): OutputBatch | null {
    const batches = this.push(event, options);
    return batches.length > 0 ? batches[batches.length - 1] : null;
  }

  pushAndFlush(
    event: ChangeStreamEvent,
    options: PushOptions = {},
  ): OutputBatch[] {
    return [...this.push(event, options), ...this.flush()];
  }

  process(
    event: ChangeStreamEvent,
    options: PushOptions = {},
  ): OutputBatch[] {
    return this.push(event, options);
  }

  consume(
    event: ChangeStreamEvent,
    options: PushOptions = {},
  ): OutputBatch[] {
    return this.push(event, options);
  }

  add(event: ChangeStreamEvent, options: PushOptions = {}): OutputBatch[] {
    return this.push(event, options);
  }

  applyChange(
    event: ChangeStreamEvent,
    options: PushOptions = {},
  ): OutputBatch[] {
    return this.push(event, options);
  }

  ingestMany(events: Iterable<ChangeStreamEvent>): OutputBatch[] {
    const output: OutputBatch[] = [];
    for (const event of events) output.push(...this.push(event));
    output.push(...this.flush());
    return output;
  }

  pushMany(events: Iterable<ChangeStreamEvent>): OutputBatch[] {
    return this.ingestMany(events);
  }

  flush(): OutputBatch[] {
    const output: OutputBatch[] = [];
    for (const key of this.openTransactionKeys) {
      output.push(...this.flushTransaction(key));
    }
    return output;
  }

  flushTransactions(): OutputBatch[] {
    return this.flush();
  }

  flushTransaction(key: string): OutputBatch[] {
    const transaction = this._openTransactions.get(key);
    if (!transaction) return [];
    this._openTransactions.delete(key);
    if (transaction.events.length === 0) return [];

    for (const event of transaction.events) {
      if (event.transaction) {
        event.transaction.eventCount = transaction.events.length;
      }
    }
    const batch = this.recordBatch(
      this.createBatch(
        "transaction",
        transaction.events,
        transaction.token,
        key,
      ),
    );
    return [batch];
  }

  /**
   * Acknowledge the output batch. The token is committed only if every
   * earlier batch in the same generation has also been acknowledged.
   */
  acknowledge(
    batchOrId: OutputBatch | number | string,
    at: Date = this.now(),
  ): AcknowledgeResult {
    const acknowledgedAt = validDate(at, "acknowledgedAt");
    const batchId = batchIdOf(batchOrId);
    if (batchId === null) {
      return this.ackResult(-1, false, false, [], null, "unknown-batch");
    }

    const batch = this._batches.get(batchId);
    if (!batch) {
      return this.ackResult(batchId, false, false, [], null, "unknown-batch");
    }

    if (batch.generation !== this._generationNumber) {
      const alreadyCommitted = batch.status === "committed";
      return this.ackResult(
        batchId,
        false,
        alreadyCommitted,
        [],
        this.resumeToken,
        "stale-generation",
      );
    }

    if (batch.status === "abandoned" || batch.status === "rejected") {
      return this.ackResult(
        batchId,
        false,
        false,
        [],
        this.resumeToken,
        `batch-${batch.status}`,
      );
    }

    if (batch.status === "committed") {
      return this.ackResult(
        batchId,
        true,
        true,
        [],
        this.resumeToken,
      );
    }

    const alreadyAcknowledged = batch.status === "acknowledged";
    if (!alreadyAcknowledged) {
      batch.status = "acknowledged";
      batch.acknowledgedAt = acknowledgedAt;
    }

    const committed = this.drainCommits(acknowledgedAt);
    return this.ackResult(
      batchId,
      true,
      alreadyAcknowledged,
      committed,
      this.resumeToken,
    );
  }

  ack(
    batchOrId: OutputBatch | number | string,
    at?: Date,
  ): AcknowledgeResult {
    return this.acknowledge(batchOrId, at);
  }

  commit(
    batchOrId: OutputBatch | number | string,
    at?: Date,
  ): AcknowledgeResult {
    return this.acknowledge(batchOrId, at);
  }

  commitBatch(
    batchOrId: OutputBatch | number | string,
    at?: Date,
  ): AcknowledgeResult {
    return this.acknowledge(batchOrId, at);
  }

  confirmBatch(
    batchOrId: OutputBatch | number | string,
    at?: Date,
  ): AcknowledgeResult {
    return this.acknowledge(batchOrId, at);
  }

  acknowledgeBatch(
    batchOrId: OutputBatch | number | string,
    at?: Date,
  ): AcknowledgeResult {
    return this.acknowledge(batchOrId, at);
  }

  reject(batchOrId: OutputBatch | number | string): boolean {
    const batchId = batchIdOf(batchOrId);
    if (batchId === null) return false;
    const batch = this._batches.get(batchId);
    if (!batch || batch.generation !== this._generationNumber) return false;
    if (batch.status === "committed") return false;
    if (batch.status === "abandoned" || batch.status === "rejected") {
      return true;
    }
    batch.status = "rejected";
    return true;
  }

  /**
   * Commit a token directly only if a batch carrying that token has already
   * been acknowledged. A pending batch is never advanced by this helper.
   */
  commitToken(token: unknown): AcknowledgeResult {
    const target = stableStringify(token);
    let found: OutputBatch | null = null;
    for (const batch of this.currentGenerationBatches()) {
      if (batch.token !== null && stableStringify(batch.token) === target) {
        found = batch;
      }
    }
    if (!found) {
      return this.ackResult(-1, false, false, [], this.resumeToken, "unknown-token");
    }
    if (found.status === "pending") {
      return this.ackResult(
        found.id,
        false,
        false,
        [],
        this.resumeToken,
        "batch-not-acknowledged",
      );
    }
    return this.acknowledge(found);
  }

  // ---------------------------------------------------------------------
  // Full document lookup
  // ---------------------------------------------------------------------

  async resolveFullDocument(
    event: ChangeStreamEvent,
    lookup: LookupSource,
    options: FullDocumentResolveOptions = {},
  ): Promise<FullDocumentLookupEvidence> {
    return resolveFullDocument(event, lookup, {
      ...options,
      namespace:
        options.namespace ??
        this.resolveNamespace(normalizeNamespace(event.ns)) ??
        this._currentNamespace,
    });
  }

  async lookupFullDocument(
    event: ChangeStreamEvent,
    lookup: LookupSource,
    options: FullDocumentResolveOptions = {},
  ): Promise<FullDocumentLookupEvidence> {
    return this.resolveFullDocument(event, lookup, options);
  }

  async pushWithLookup(
    event: ChangeStreamEvent,
    lookup: LookupSource,
    options: FullDocumentResolveOptions = {},
  ): Promise<OutputBatch[]> {
    if (event.operationType === "invalidate") {
      return this.push(event);
    }
    const evidence = await this.resolveFullDocument(event, lookup, options);
    return this.push(event, { fullDocumentLookup: evidence });
  }

  async ingestWithLookup(
    event: ChangeStreamEvent,
    lookup: LookupSource,
    options: FullDocumentResolveOptions = {},
  ): Promise<OutputBatch[]> {
    return this.pushWithLookup(event, lookup, options);
  }

  async ingestManyWithLookup(
    events: Iterable<ChangeStreamEvent>,
    lookup: LookupSource,
    options: FullDocumentResolveOptions = {},
  ): Promise<OutputBatch[]> {
    const output: OutputBatch[] = [];
    for (const event of events) {
      output.push(...(await this.pushWithLookup(event, lookup, options)));
    }
    output.push(...this.flush());
    return output;
  }

  // ---------------------------------------------------------------------
  // Generations, invalidate and history lost
  // ---------------------------------------------------------------------

  invalidate(
    cause?: unknown,
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.transition("invalidate", { ...options, cause });
  }

  handleInvalidate(
    cause?: unknown,
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.invalidate(cause, options);
  }

  historyLost(
    error?: unknown,
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.transition("history-lost", { ...options, cause: error });
  }

  handleHistoryLost(
    error?: unknown,
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.historyLost(error, options);
  }

  onHistoryLost(
    error?: unknown,
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.historyLost(error, options);
  }

  handleError(error: unknown): GenerationTransition | null {
    if (isHistoryLostError(error)) return this.historyLost(error);
    return null;
  }

  startSnapshotGeneration(
    reason: GenerationReason = "snapshot",
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.transition(reason, options);
  }

  startNewSnapshotGeneration(
    reason: GenerationReason = "snapshot",
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.startSnapshotGeneration(reason, options);
  }

  newSnapshotGeneration(
    reason: GenerationReason = "snapshot",
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.startSnapshotGeneration(reason, options);
  }

  startNewGeneration(
    reason: GenerationReason = "manual",
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    return this.transition(reason, options);
  }

  beginSnapshot(options: SnapshotBeginOptions = {}): SnapshotGeneration {
    if (this.currentInternal.status === "live") {
      this.transition("snapshot", {
        at: options.startAt,
        entryResumeToken: options.entryResumeToken,
      });
    }
    const generation = this.currentInternal;
    const at = options.startAt
      ? validDate(options.startAt, "snapshot startAt")
      : this.now();
    if (generation.status === "snapshot-required") {
      generation.status = "snapshotting";
    }
    generation.snapshotStartedAt ??= at;
    if (options.entryResumeToken !== undefined) {
      generation.entryResumeToken = options.entryResumeToken;
    }
    return this.cloneGeneration(generation);
  }

  startSnapshot(options: SnapshotBeginOptions = {}): SnapshotGeneration {
    return this.beginSnapshot(options);
  }

  completeSnapshot(
    options: SnapshotCompleteOptions = {},
  ): SnapshotGeneration {
    if (this.currentInternal.status === "live") {
      // Completing a snapshot on a live generation simply installs its new
      // base token; there is no old cursor to splice because the token is
      // supplied by the new snapshot itself.
      if (options.resumeToken === undefined) return this.currentGeneration;
      this.currentInternal.resumeToken = options.resumeToken;
      this.currentInternal.tokenAtSnapshot = options.resumeToken;
      return this.currentGeneration;
    }

    const at = options.readTime
      ? validDate(options.readTime, "snapshot readTime")
      : this.now();
    const generation = this.currentInternal;
    generation.snapshotStartedAt ??= options.startAt
      ? validDate(options.startAt, "snapshot startAt")
      : at;
    generation.status = "live";
    generation.completedAt = at;
    if (options.resumeToken !== undefined) {
      generation.resumeToken = options.resumeToken;
      generation.tokenAtSnapshot = options.resumeToken;
    } else {
      generation.tokenAtSnapshot = null;
    }
    return this.cloneGeneration(generation);
  }

  // ---------------------------------------------------------------------
  // Rename tracking
  // ---------------------------------------------------------------------

  applyRename(
    from: Namespace | string,
    to: Namespace | string,
  ): Namespace | null {
    const source = normalizeNamespace(from);
    const target = normalizeNamespace(to);
    if (!source || !target) return null;

    const sourceKey = namespaceKey(source);
    if (sourceKey === null) return null;
    this._namespaceMap.set(sourceKey, target);

    const effective = this.resolveNamespace(target) ?? target;
    if (sameNamespace(this._currentNamespace, source)) {
      this._currentNamespace = cloneNamespace(effective);
    }
    return cloneNamespace(effective);
  }

  resolveNamespace(
    namespace: Namespace | string | null,
  ): Namespace | null {
    let current = normalizeNamespace(namespace);
    if (!current) return null;

    const visited = new Set<string>();
    for (let step = 0; step < 32; step += 1) {
      const key = namespaceKey(current);
      if (key === null || visited.has(key)) break;
      visited.add(key);
      const next = this._namespaceMap.get(key);
      if (!next) break;
      if (sameNamespace(next, current)) break;
      current = next;
    }
    return cloneNamespace(current);
  }

  listRenameMappings(): ReadonlyArray<{ from: string; to: Namespace }> {
    return [...this._namespaceMap.entries()]
      .map(([from, to]) => ({ from, to: cloneNamespace(to) as Namespace }))
      .sort((left, right) => left.from.localeCompare(right.from));
  }

  clearRenameMappings(): void {
    this._namespaceMap.clear();
  }

  // ---------------------------------------------------------------------
  // Serialization helpers
  // ---------------------------------------------------------------------

  toJSON(): Record<string, unknown> {
    return {
      generation: this.currentGeneration,
      resumeToken: this.resumeToken,
      previousResumeToken: this.previousResumeToken,
      currentNamespace: this.currentNamespace,
      namespaces: this.listRenameMappings(),
      pendingBatchIds: this.pendingBatches.map((batch) => batch.id),
      committedBatchIds: this.committedBatchIds,
    };
  }

  private now(): Date {
    return validDate(this.clock(), "clock result");
  }

  private makeGenerationId(
    number: number,
    reason: GenerationReason,
    at: Date,
  ): string {
    if (this.idFactory) return this.idFactory(number);
    return `${number}:${reason}:${at.toISOString()}`;
  }

  private get currentInternal(): InternalGeneration {
    return this._generations[this._generations.length - 1];
  }

  private cloneGeneration(
    generation: InternalGeneration,
  ): SnapshotGeneration {
    return {
      number: generation.number,
      id: generation.id,
      reason: generation.reason,
      status: generation.status,
      startedAt: cloneDate(generation.startedAt),
      snapshotStartedAt: generation.snapshotStartedAt
        ? cloneDate(generation.snapshotStartedAt)
        : null,
      completedAt: generation.completedAt
        ? cloneDate(generation.completedAt)
        : null,
      closedAt: generation.closedAt ? cloneDate(generation.closedAt) : null,
      entryResumeToken: generation.entryResumeToken,
      resumeToken: generation.resumeToken,
      tokenAtSnapshot: generation.tokenAtSnapshot,
      previousResumeToken: generation.previousResumeToken,
      abandonedBatches: generation.abandonedBatches,
      committedBatches: generation.committedBatches,
      cause: generation.cause,
    };
  }

  private transition(
    reason: GenerationReason,
    options: NewGenerationOptions = {},
  ): GenerationTransition {
    const at = options.at
      ? validDate(options.at, "transition at")
      : this.now();
    const from = this.currentInternal;
    from.status = "closed";
    from.closedAt = at;

    const previousResumeToken = from.resumeToken;
    const abandonedBatchIds: number[] = [];
    for (const batch of this._batches.values()) {
      if (batch.generation !== from.number) continue;
      if (
        batch.status === "pending" ||
        batch.status === "acknowledged"
      ) {
        batch.status = "abandoned";
        abandonedBatchIds.push(batch.id);
      }
    }
    from.abandonedBatches += abandonedBatchIds.length;
    this._openTransactions.clear();

    this._generationNumber += 1;
    const next: InternalGeneration = {
      number: this._generationNumber,
      id: this.makeGenerationId(this._generationNumber, reason, at),
      reason,
      status: "snapshot-required",
      startedAt: at,
      snapshotStartedAt: null,
      completedAt: null,
      closedAt: null,
      entryResumeToken: options.entryResumeToken ?? null,
      resumeToken: null,
      tokenAtSnapshot: null,
      previousResumeToken,
      abandonedBatches: 0,
      committedBatches: 0,
      cause: options.cause ?? null,
      firstBatchId: null,
    };
    this._generations.push(next);

    const transition: GenerationTransition = {
      from: this.cloneGeneration(from),
      to: this.cloneGeneration(next),
      reason,
      at,
      previousResumeToken,
      abandonedBatchIds,
      cause: options.cause ?? null,
    };
    this._lastTransition = transition;
    return transition;
  }

  private handleInvalidateEvent(
    event: ChangeStreamEvent,
    options: PushOptions,
  ): OutputBatch[] {
    const token = resumeTokenOf(event);
    const transition = this.transition("invalidate", {
      cause: event,
      entryResumeToken: undefined,
    });
    const outputEvent = this.buildOutputEvent(
      event,
      undefined,
      options.fullDocumentLookup,
    );
    const control: BatchControl = {
      type: "invalidate",
      resumeToken: token,
      previousGeneration: transition.from.number,
      nextGeneration: transition.to.number,
      reason: "invalidate",
      at: transition.at,
    };
    const batch = this.recordBatch(
      this.createBatch("control", [outputEvent], null, null, control),
    );
    return [batch];
  }

  private buildOutputEvent(
    event: ChangeStreamEvent,
    transaction?: TransactionDescriptor,
    lookup?: FullDocumentLookupEvidence,
  ): OutputEvent {
    const names = this.namespaceForEvent(event);
    const eventTime = event.clusterTime ?? event.wallTime ?? null;
    const output: OutputEvent = {
      operationType: event.operationType,
      namespace: names.namespace,
      previousNamespace: names.previousNamespace,
      documentKey: event.documentKey ?? null,
      resumeToken: resumeTokenOf(event),
      eventTime,
      eventTimeMs: normalizeTimestampMs(eventTime),
      wallTime: event.wallTime ?? null,
      wallTimeMs: normalizeTimestampMs(event.wallTime),
      raw: event,
    };

    if (event.fullDocument !== undefined) {
      output.fullDocument = event.fullDocument;
    }
    if (event.fullDocumentBeforeChange !== undefined) {
      output.fullDocumentBeforeChange = event.fullDocumentBeforeChange;
    }
    if (event.updateDescription !== undefined) {
      output.updateDescription = event.updateDescription;
    }
    if (transaction) output.transaction = transaction;
    if (isRenameEvent(event)) output.renamed = true;
    if (lookup) {
      output.fullDocument = lookup.document;
      output.readTime = cloneDate(lookup.readTime);
      output.readTimeMs = lookup.readTimeMs;
      output.fullDocumentLookup = lookup;
      output.fullDocumentEvidence = lookup;
    }
    return output;
  }

  private namespaceForEvent(event: ChangeStreamEvent): {
    namespace: Namespace | null;
    previousNamespace: Namespace | null;
  } {
    const original = normalizeNamespace(event.ns);

    if (isRenameEvent(event)) {
      const source = original ?? this._currentNamespace;
      const target =
        normalizeNamespace(event.to) ??
        (source ? this.resolveNamespace(source) : null);
      if (source && target) {
        const effective = this.applyRename(source, target) ?? target;
        this._currentNamespace = cloneNamespace(effective);
        return {
          namespace: cloneNamespace(effective),
          previousNamespace: cloneNamespace(source),
        };
      }
    }

    const base = original ?? this._currentNamespace;
    const resolved = this.resolveNamespace(base);
    if (resolved) this._currentNamespace = cloneNamespace(resolved);
    return {
      namespace: cloneNamespace(resolved),
      previousNamespace:
        original && resolved && !sameNamespace(original, resolved)
          ? cloneNamespace(original)
          : null,
    };
  }

  private createBatch(
    kind: BatchKind,
    events: OutputEvent[],
    token: unknown,
    transactionKey: string | null,
    control?: BatchControl,
  ): OutputBatch {
    const id = this._nextBatchId;
    this._nextBatchId += 1;
    const batch: OutputBatch = {
      id,
      generation: this._generationNumber,
      kind,
      status: "pending",
      events,
      token: token ?? null,
      transactionKey,
      createdAt: this.now(),
    };
    if (control) batch.control = control;
    this._batchOrder.push(id);
    this._batches.set(id, batch);
    const generation = this.currentInternal;
    generation.firstBatchId ??= id;
    return batch;
  }

  private recordBatch(batch: OutputBatch): OutputBatch {
    this._lastOutputBatch = batch;
    return batch;
  }

  private currentGenerationBatches(): OutputBatch[] {
    return this._batchOrder
      .map((id) => this._batches.get(id))
      .filter(
        (batch): batch is OutputBatch =>
          batch !== undefined && batch.generation === this._generationNumber,
      )
      .sort((left, right) => left.id - right.id);
  }

  private drainCommits(at: Date): number[] {
    const committed: number[] = [];
    for (const batch of this.currentGenerationBatches()) {
      if (batch.status === "committed") continue;
      // Control batches carry no resume token. The generation transition
      // already happened when they were emitted, so they do not block a
      // later token from becoming durable.
      if (batch.kind === "control" && batch.status === "pending") continue;
      if (batch.status !== "acknowledged") break;

      batch.status = "committed";
      batch.committedAt = at;
      const generation = this.currentInternal;
      generation.committedBatches += 1;
      if (batch.token !== null) {
        generation.resumeToken = batch.token;
      }
      if (generation.status === "snapshot-required") {
        // A fresh stream after a snapshot may begin delivering events before
        // the caller explicitly completes the snapshot. Those events belong
        // to the new generation and are safe to commit.
        generation.status = "live";
      }
      committed.push(batch.id);
    }
    return committed;
  }

  private ackResult(
    batchId: number,
    accepted: boolean,
    alreadyAcknowledged: boolean,
    committedBatchIds: number[],
    committedToken: unknown,
    reason?: string,
  ): AcknowledgeResult {
    const result: AcknowledgeResult = {
      batchId,
      accepted,
      alreadyAcknowledged,
      committed: committedBatchIds.length > 0,
      committedBatchIds,
      committedToken,
      waitingFor: this.currentGenerationBatches()
        .filter((batch) => batch.status === "pending")
        .map((batch) => batch.id),
    };
    if (reason !== undefined) result.reason = reason;
    return result;
  }

  private assertEvent(event: ChangeStreamEvent): void {
    if (
      !isRecord(event) ||
      typeof event.operationType !== "string" ||
      event.operationType.length === 0
    ) {
      throw new TypeError(
        "change stream event must be an object with a non-empty operationType",
      );
    }
  }
}

export { ChangeStreamState as ChangeStreamTracker };
export { ChangeStreamState as ChangeStreamStateMachine };

export function createChangeStreamState(
  options: ChangeStreamStateOptions = {},
): ChangeStreamState {
  return new ChangeStreamState(options);
}

export function createChangeStreamTracker(
  options: ChangeStreamStateOptions = {},
): ChangeStreamState {
  return new ChangeStreamState(options);
}

export const createState = createChangeStreamState;
