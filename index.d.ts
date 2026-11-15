/**
 * Debezium transaction reassembly.
 *
 * The reassembler buffers Debezium data events by transaction id and only
 * exposes a transaction after its END metadata has arrived and every event
 * ordinal declared by the metadata is present. It never emits a partial
 * transaction, including when a timeout is reported or state is restored
 * after a crash.
 */
export type JsonRecord = Record<string, any>;
export type DebeziumEvent = JsonRecord;
export type DataEvent = JsonRecord;
export type TransactionStatus = "BEGIN" | "END" | "ABORT";
export interface TransactionDataCollection {
    data_collection?: string;
    dataCollection?: string;
    event_count?: number;
    eventCount?: number;
}
export interface DebeziumTransactionMetadata extends JsonRecord {
    id?: string | number;
    status?: string;
    event_count?: number;
    eventCount?: number;
    data_collections?: TransactionDataCollection[];
    dataCollections?: TransactionDataCollection[];
}
export type TransactionMetadataEvent = DebeziumTransactionMetadata;
export type TransactionBoundaryEvent = DebeziumTransactionMetadata;
export interface TransactionMetadata {
    id: string;
    status: TransactionStatus;
    eventCount: number | null;
    dataCollections: Array<{
        dataCollection: string;
        eventCount: number;
    }>;
    receivedAt: number;
    raw: any;
    value: JsonRecord;
}
export interface TransactionBatch {
    transactionId: string;
    events: any[];
    eventCount: number;
    transactional: true;
    complete: true;
    begin: JsonRecord | null;
    end: JsonRecord | null;
    metadata: {
        begin: JsonRecord | null;
        end: JsonRecord | null;
    };
    dataCollections: Array<{
        dataCollection: string;
        eventCount: number;
    }>;
    collections: Array<{
        dataCollection: string;
        eventCount: number;
    }>;
    duplicateCount: number;
    committedAt: number;
    id?: string;
    records?: any[];
    data?: any[];
    count?: number;
    event_count?: number;
}
export interface NonTransactionalBatch {
    transactionId: null;
    events: [any];
    eventCount: 1;
    transactional: false;
    complete: true;
    begin: null;
    end: null;
    metadata: {
        begin: null;
        end: null;
    };
    dataCollections: Array<{
        dataCollection: string | null;
        eventCount: number;
    }>;
    collections: Array<{
        dataCollection: string | null;
        eventCount: number;
    }>;
    duplicateCount: 0;
    committedAt: number;
    id?: null;
    event?: any;
    record?: any;
    records?: any[];
    count?: 1;
}
export type CommitBatch = TransactionBatch | NonTransactionalBatch;
export type TransactionCommitBatch = TransactionBatch;
export type ReassembledTransaction = TransactionBatch;
export interface TransactionGap {
    transactionId: string;
    reason: "timeout" | "missing-sequence" | "missing-total-order" | "missing-data-collection-order" | "missing-end" | "unexpected-event" | "conflict" | "invalid-metadata" | "incomplete";
    missingTotalOrders: number[];
    missingDataCollectionOrders: Record<string, number[]>;
    missingCollections: string[];
    expectedEventCount: number | null;
    receivedEventCount: number;
    unsequencedEventCount: number;
    awaitingEnd: boolean;
    timedOut: boolean;
    conflict: boolean;
    cause?: TransactionGap["reason"];
    validationReason?: TransactionGap["reason"];
    ageMs: number;
    lastUpdatedAt: number;
    details: string | null;
    id?: string;
    missingOrders?: number[];
    missing_orders?: number[];
}
export interface TransactionReassemblerOptions {
    /** Idle time before an incomplete transaction is reported as a gap. */
    timeoutMs?: number;
    timeout?: number;
    transactionTimeoutMs?: number;
    transactionTimeout?: number;
    idleTimeoutMs?: number;
    idleTimeout?: number;
    /** Injectable clock, primarily for deterministic tests and recovery. */
    now?: (() => number) | number;
    clock?: () => number;
    /** Called whenever a complete transaction (or non-transactional event) is delivered. */
    onCommit?: (batch: CommitBatch) => void;
    onTransaction?: (batch: CommitBatch) => void;
    onBatch?: (batch: CommitBatch) => void;
    /** Called for each gap returned by checkTimeouts()/reportGaps(). */
    onGap?: (gap: TransactionGap) => void;
    onTimeout?: (gap: TransactionGap) => void;
    /**
     * When false, completed transactions are held until drain()/flush().
     * They are still complete and recoverable; ingest() simply does not return
     * them immediately. Defaults to true.
     */
    autoCommit?: boolean;
    /** Bound the recovery ledger retained in snapshots. Defaults to no bound. */
    maxDeliveredTransactionIds?: number;
    /** Number of delivered batches kept for inspection. Defaults to 1000. */
    maxCommittedHistory?: number;
}
export interface IngestOptions {
    receivedAt?: number;
    at?: number;
    now?: number;
    metadata?: any;
    transactionMetadata?: any;
}
export interface TimeoutOptions {
    timeoutMs?: number;
    timeout?: number;
    ms?: number;
    now?: number;
    at?: number;
}
export declare class TransactionReassemblyError extends Error {
    code: string;
    constructor(message: string, code?: string);
}
export declare class DuplicateEventConflictError extends TransactionReassemblyError {
    transactionId: string;
    totalOrder: number | null;
    existingEvent: any;
    incomingEvent: any;
    existing: any;
    incoming: any;
    kind: string;
    constructor(transactionId: string, totalOrder: number | null, existingEvent: any, incomingEvent: any, kind?: string);
}
export declare class InvalidTransactionMetadataError extends TransactionReassemblyError {
    metadata: any;
    constructor(message: string, metadata: any);
}
export declare class SnapshotError extends TransactionReassemblyError {
    constructor(message: string);
}
interface SnapshotRecord {
    totalOrder: number;
    dataCollectionOrder: number | null;
    dataCollection: string | null;
    topic: string | null;
    partition: number | null;
    offset: number | null;
    event: any;
    receivedAt: number;
}
interface SnapshotMetadata {
    id: string;
    status: TransactionStatus;
    eventCount: number | null;
    dataCollections: Array<{
        dataCollection: string;
        eventCount: number;
    }>;
    receivedAt: number;
    raw: any;
    value: JsonRecord;
}
export interface TransactionStateSnapshot {
    id: string;
    begin: SnapshotMetadata | null;
    end: SnapshotMetadata | null;
    records: SnapshotRecord[];
    unsequenced: SnapshotRecord[];
    conflict: boolean;
    conflictReason: string | null;
    createdAt: number;
    updatedAt: number;
    endOrder: number;
    duplicateCount: number;
    completed: boolean;
}
export interface TransactionReassemblerSnapshot {
    version: 1;
    savedAt: number;
    endSequence: number;
    delivered: string[];
    aborted: string[];
    transactions: TransactionStateSnapshot[];
}
export type ReassemblerOptions = TransactionReassemblerOptions;
export type TransactionGapReport = TransactionGap;
export type TransactionReassemblerState = TransactionReassemblerSnapshot;
export type IngestResult = CommitBatch[] & {
    batches: CommitBatch[];
    committed: CommitBatch[];
    transactions: CommitBatch[];
    gaps: TransactionGap[];
    batch?: CommitBatch | null;
    first?: CommitBatch | null;
    ready: CommitBatch[];
    pending?: Array<Record<string, any>>;
    pendingCount?: number;
    reassembler?: TransactionReassembler;
};
export type GapResult = TransactionGap[] & {
    gaps: TransactionGap[];
};
type EventListener = (...args: any[]) => void;
/**
 * A small EventEmitter-compatible surface. Keeping it local means the library
 * has no runtime or compile-time dependency on @types/node.
 */
export declare class MiniEventEmitter {
    private _listeners;
    constructor();
    on(event: string | symbol, listener: EventListener): this;
    addListener(event: string | symbol, listener: EventListener): this;
    prependListener(event: string | symbol, listener: EventListener): this;
    once(event: string | symbol, listener: EventListener): this;
    off(event: string | symbol, listener: EventListener): this;
    removeListener(event: string | symbol, listener: EventListener): this;
    removeAllListeners(event?: string | symbol): this;
    listeners(event: string | symbol): EventListener[];
    listenerCount(event: string | symbol): number;
    eventNames(): Array<string | symbol>;
    emit(event: string | symbol, ...args: any[]): boolean;
}
export declare function deepEqual(left: any, right: any): boolean;
export declare class TransactionReassembler extends MiniEventEmitter {
    timeoutMs: number;
    autoCommit: boolean;
    private _clock;
    private _maxDelivered;
    private _transactions;
    private _ready;
    private _delivered;
    private _aborted;
    private _endSequence;
    private _onCommit;
    private _onGap;
    private _onTimeout;
    private _history;
    private _maxHistory;
    lastRecovered: CommitBatch[];
    constructor(options?: TransactionReassemblerOptions | number);
    get pendingCount(): number;
    get size(): number;
    get length(): number;
    get bufferedCount(): number;
    get deliveredCount(): number;
    get transactionIds(): string[];
    get committedBatches(): CommitBatch[];
    get history(): CommitBatch[];
    ingest(input: any, second?: any): IngestResult;
    push(input: any, second?: any): IngestResult;
    add(input: any, second?: any): IngestResult;
    accept(input: any, second?: any): IngestResult;
    consume(input: any, second?: any): IngestResult;
    handle(input: any, second?: any): IngestResult;
    record(input: any, second?: any): IngestResult;
    process(input: any, second?: any): IngestResult;
    enqueue(input: any, second?: any): IngestResult;
    feed(input: any, second?: any): IngestResult;
    receive(input: any, second?: any): IngestResult;
    apply(input: any, second?: any): IngestResult;
    ingestDataEvent(input: any, second?: any): IngestResult;
    handleDataEvent(input: any, second?: any): IngestResult;
    addDataEvent(input: any, second?: any): IngestResult;
    ingestTransactionMetadata(metadata: any): IngestResult;
    handleTransactionMetadata(metadata: any): IngestResult;
    addMetadata(metadata: any): IngestResult;
    consumeTransactionMetadata(metadata: any): IngestResult;
    ingestMany(events: Iterable<any>, options?: IngestOptions): IngestResult;
    pushMany(events: Iterable<any>, options?: IngestOptions): IngestResult;
    addMany(events: Iterable<any>, options?: IngestOptions): IngestResult;
    consumeAll(events: Iterable<any>, options?: IngestOptions): IngestResult;
    drain(): IngestResult;
    flush(first?: number | Date | TimeoutOptions, second?: number): IngestResult;
    commitReady(): IngestResult;
    take(): IngestResult;
    takeCommitted(): IngestResult;
    getCommitted(): IngestResult;
    getCommittedBatches(): CommitBatch[];
    getReadyBatches(): IngestResult;
    poll(): CommitBatch | null;
    private _result;
    private _resultWithGaps;
    reportGaps(options?: TimeoutOptions | number | Date): GapResult;
    gaps(options?: TimeoutOptions | number | Date): GapResult;
    getGaps(options?: TimeoutOptions | number | Date): GapResult;
    checkTimeouts(first?: number | Date | TimeoutOptions, second?: number): GapResult;
    checkTimeoutsAt(now: number, timeoutMs?: number): GapResult;
    expire(first?: number | Date | TimeoutOptions, second?: number): GapResult;
    timeout(first?: number | Date | TimeoutOptions, second?: number): GapResult;
    reportTimeouts(first?: number | Date | TimeoutOptions, second?: number): GapResult;
    expireTransactions(first?: number | Date | TimeoutOptions, second?: number): GapResult;
    snapshot(): TransactionReassemblerSnapshot;
    serialize(): string;
    save(): string;
    dump(): TransactionReassemblerSnapshot;
    toJSON(): TransactionReassemblerSnapshot;
    restore(snapshot: TransactionReassemblerSnapshot | string | JsonRecord): IngestResult;
    recover(snapshot: TransactionReassemblerSnapshot | string | JsonRecord): IngestResult;
    loadSnapshot(snapshot: TransactionReassemblerSnapshot | string | JsonRecord): IngestResult;
    load(snapshot: TransactionReassemblerSnapshot | string | JsonRecord): IngestResult;
    hydrate(snapshot: TransactionReassemblerSnapshot | string | JsonRecord): IngestResult;
    restoreFrom(snapshot: TransactionReassemblerSnapshot | string | JsonRecord): IngestResult;
    pendingTransactions(): Array<{
        transactionId: string;
        eventCount: number;
        expectedEventCount: number | null;
        complete: boolean;
        conflict: boolean;
        createdAt: number;
        updatedAt: number;
    }>;
    getOpenTransactions(): Array<Record<string, any>>;
    getPendingTransactions(): Array<Record<string, any>>;
    getPending(): Array<Record<string, any>>;
    getOpen(): Array<Record<string, any>>;
    getBufferedTransactions(): Array<Record<string, any>>;
    getBuffered(): Array<Record<string, any>>;
    getTransaction(transactionId: string): Record<string, any> | null;
    hasTransaction(transactionId: string): boolean;
    removeTransaction(transactionId: string): boolean;
    stats(): Record<string, number>;
    clear(): void;
    reset(): void;
    static fromSnapshot(snapshot: TransactionReassemblerSnapshot | string | JsonRecord, options?: TransactionReassemblerOptions): TransactionReassembler;
    static fromJSON(snapshot: TransactionReassemblerSnapshot | string | JsonRecord, options?: TransactionReassemblerOptions): TransactionReassembler;
    static restore(snapshot: TransactionReassemblerSnapshot | string | JsonRecord, options?: TransactionReassemblerOptions): TransactionReassembler;
    static recover(snapshot: TransactionReassemblerSnapshot | string | JsonRecord, options?: TransactionReassemblerOptions): TransactionReassembler;
    static fromEvents(events: Iterable<any>, options?: TransactionReassemblerOptions): TransactionReassembler;
    private _parseIngestArguments;
    private _handleMetadata;
    private _checkDeliveredMetadata;
    private _handleData;
    private _checkDeliveredDuplicate;
    private _deliverNonTransactional;
    private _tryComplete;
    private _deliver;
    private _trimDelivered;
    private _validate;
    private _gapFor;
    private _notifyGap;
    private _metadataEqual;
    private _serializeState;
    private _serializeMetadata;
    private _serializeRecord;
    private _deserializeState;
    private _deserializeMetadata;
    private _deserializeRecord;
}
export { TransactionReassembler as TransactionAssembler, TransactionReassembler as TransactionBuffer, TransactionReassembler as DebeziumTransactionReassembler, TransactionReassembler as DebeziumTransactionBuffer, TransactionReassembler as DebeziumTransactionAssembler, TransactionReassembler as TransactionComposer, TransactionReassembler as TransactionCommitBuffer, TransactionReassembler as TransactionReorganizationBuffer, TransactionReassembler as TransactionReassemblyBuffer, TransactionReassembler as TransactionBatchAssembler, TransactionReassembler as DebeziumTransactionCoordinator, TransactionReassembler as TransactionEngine, TransactionReassembler as DebeziumTransactionEngine, };
export declare const DuplicateConflictError: typeof DuplicateEventConflictError;
export declare const TransactionOrderConflictError: typeof DuplicateEventConflictError;
export declare const InvalidMetadataError: typeof InvalidTransactionMetadataError;
export declare const InvalidSnapshotError: typeof SnapshotError;
export declare function isTransactionMetadata(event: any): boolean;
export declare const isTransactionMetadataEvent: typeof isTransactionMetadata;
export declare const isMetadataEvent: typeof isTransactionMetadata;
export declare function isTransactionalEvent(event: any): boolean;
export declare const isTransactionEvent: typeof isTransactionalEvent;
export declare const hasTransactionMetadata: typeof isTransactionalEvent;
export declare function createTransactionReassembler(options?: TransactionReassemblerOptions | number): TransactionReassembler;
export declare const createReassembler: typeof createTransactionReassembler;
export declare const createTransactionBuffer: typeof createTransactionReassembler;
export declare const createTransactionAssembler: typeof createTransactionReassembler;
export declare function reassembleTransactions(events: Iterable<any>, options?: TransactionReassemblerOptions | number): IngestResult;
export declare const reassemble: typeof reassembleTransactions;
export declare const assembleTransactions: typeof reassembleTransactions;
export declare const reassembleTransactionEvents: typeof reassembleTransactions;
export declare const assembleTransactionEvents: typeof reassembleTransactions;
export declare const groupTransactions: typeof reassembleTransactions;
export default TransactionReassembler;
