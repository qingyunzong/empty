import type { DeltaQueueSnapshot } from './snapshot.js';

/**
 * A bootstrap (full/initial) load or a subsequent delta load.
 * The two kinds always run in separate, fenced generations.
 */
export type GenerationKind = 'bootstrap' | 'delta';

/** Lifecycle of one extraction request. */
export type RequestState = 'open' | 'persisted' | 'acked' | 'canceled';

/** Fencing token carried by every request and every package delivery. */
export interface GenerationToken {
  readonly subscriberId: string;
  readonly kind: GenerationKind;
  /** Monotonic per subscriber; bootstrap is always 0, deltas are 1, 2, ... */
  readonly sequence: number;
}

export interface GenerationRecord extends GenerationToken {
  readonly sealed: boolean;
  readonly openedAt: number;
  readonly sealedAt?: number;
}

export interface RequestOpenParams {
  readonly subscriberId: string;
  readonly requestId: string;
  readonly generation: GenerationToken;
  /**
   * Exactly one of `expectedPackageIds` / `expectedPackageCount` must be set.
   * Explicit ids give strict membership; a count accepts any distinct ids.
   */
  readonly expectedPackageIds?: readonly string[];
  readonly expectedPackageCount?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface PackageDelivery {
  readonly subscriberId: string;
  readonly requestId: string;
  readonly generation: GenerationToken;
  readonly packageId: string;
  /** Opaque connector payload; the state machine never inspects it. */
  readonly payload: unknown;
  /** Optional integrity checksum; conflicting duplicates are rejected. */
  readonly checksum?: string;
}

/** Command handed to the persistence sink for the first delivery only. */
export interface PackagePersistCommand {
  readonly subscriberId: string;
  readonly requestId: string;
  readonly generation: GenerationToken;
  readonly packageId: string;
  readonly payload: unknown;
  readonly checksum?: string;
}

/**
 * Final confirmation receipt. It binds the subscriber, request, generation
 * and the complete set of package ids, and is emitted only after every
 * package of the request has been persisted.
 */
export interface AckReceipt {
  readonly subscriberId: string;
  readonly requestId: string;
  readonly generation: GenerationToken;
  readonly packageIds: readonly string[];
  readonly packageCount: number;
  readonly acknowledgedAt: number;
}

export interface RequestRecord {
  readonly subscriberId: string;
  readonly requestId: string;
  readonly generation: GenerationToken;
  readonly state: RequestState;
  /** Null when the request was opened in count mode. */
  readonly expectedPackageIds: readonly string[] | null;
  readonly expectedPackageCount: number;
  /** First-seen order; duplicates are never appended twice. */
  readonly receivedPackageIds: readonly string[];
  readonly checksumById: Readonly<Record<string, string | undefined>>;
  readonly openedAt: number;
  readonly persistedAt?: number;
  readonly acknowledgedAt?: number;
  readonly canceledAt?: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface SubscriberRecord {
  readonly subscriberId: string;
  readonly currentGeneration: GenerationToken | null;
  readonly generations: readonly GenerationRecord[];
}

export type PackageHandleStatus = 'persisted' | 'duplicate' | 'ignored';

export interface PackageHandleResult {
  readonly status: PackageHandleStatus;
  /** Set for duplicate deliveries and terminal-state (late) packages. */
  readonly reason?:
    | 'already-persisted'
    | 'request-canceled'
    | 'request-acked';
  readonly packageId: string;
  readonly request: RequestRecord;
}

/** Durable state boundary. Implementations may use a database, file, etc. */
export interface StateStore {
  load(): Promise<DeltaQueueSnapshot>;
  save(snapshot: DeltaQueueSnapshot): Promise<void>;
}

/** Downstream landing zone (data lake / warehouse / object store). */
export interface PackageSink {
  persistPackage(command: PackagePersistCommand): Promise<void>;
}

/** Transport for the final confirmation back to the source system. */
export interface AckGateway {
  confirm(receipt: AckReceipt): Promise<void>;
}

export interface DeltaQueueOptions {
  readonly store?: StateStore;
  /** Injectable clock, mainly for deterministic tests. */
  readonly clock?: () => number;
}
