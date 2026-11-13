export type SourceVersion = string | number | bigint;

export type SourceVersionComparator = (
  left: SourceVersion,
  right: SourceVersion,
) => number;

export interface SourceChange<TPayload = unknown> {
  readonly sourceVersion: SourceVersion;
  readonly id?: string;
  readonly documentId?: string;
  readonly operation?: string;
  readonly document?: TPayload;
  readonly [key: string]: unknown;
}

export interface GenerationReference {
  readonly id: string;
  readonly [key: string]: unknown;
}

export type GenerationLike = string | GenerationReference;

export interface AliasSnapshot {
  readonly read: string | null;
  readonly write: string | null;
}

export interface CreateGenerationRequest {
  readonly id: string;
  readonly kind: "target";
}

export interface BackfillContext {
  readonly targetGeneration: string;
  readonly signal?: AbortSignal;
}

export interface BackfillResult {
  readonly sourceVersion: SourceVersion;
  readonly completed?: boolean;
}

export interface ApplyChangesContext {
  readonly reason: "backfill-catch-up" | "dual-write" | "gap-recovery";
  readonly targetGeneration: string;
  readonly signal?: AbortSignal;
}

export interface AliasSwapContext {
  readonly targetGeneration: string;
  readonly previousAliases: AliasSnapshot;
  readonly signal?: AbortSignal;
}

export interface AliasSwapReceipt {
  readonly swapped: boolean;
  readonly aliases?: AliasSnapshot;
}

export type AliasSwapOutcome =
  | boolean
  | AliasSnapshot
  | AliasSwapReceipt
  | void;

export interface VerificationContext {
  readonly targetGeneration: string;
  readonly aliases: AliasSnapshot;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly observedGeneration?: string;
  readonly detail?: string;
}

export type VerificationOutcome =
  | boolean
  | VerificationResult
  | void;

export interface DeleteGenerationContext {
  readonly targetGeneration: string;
  readonly reason: "retired-after-alias-switch";
}

export interface IndexGenerationBackend {
  createGeneration?(
    request: CreateGenerationRequest,
  ): Promise<GenerationLike | void> | GenerationLike | void;

  backfill(
    generation: string,
    context: BackfillContext,
  ): Promise<BackfillResult | void>;

  applyChanges(
    generation: string,
    changes: readonly SourceChange[],
    context: ApplyChangesContext,
  ): Promise<void>;

  getAliases(): Promise<AliasSnapshot>;

  compareAndSwapAliases(
    expected: AliasSnapshot,
    targetGeneration: string,
    context: AliasSwapContext,
  ): Promise<AliasSwapOutcome>;

  verifyReadback?(
    generation: string,
    context: VerificationContext,
  ): Promise<VerificationOutcome> | VerificationOutcome;

  deleteGeneration(
    generation: string,
    context: DeleteGenerationContext,
  ): Promise<void>;
}

export interface ReadChangesRequest {
  readonly afterVersion: SourceVersion;
  readonly throughVersion?: SourceVersion;
  readonly limit: number;
}

export interface ChangeFeed {
  readChanges(
    request: ReadChangesRequest,
  ): Promise<readonly SourceChange[]>;

  getHighWatermark?(): Promise<SourceVersion>;
}

export interface ReaderLease {
  readonly id?: string;
  readonly generation: string;
  readonly active?: boolean;
  readonly expiresAt?: Date | string | number;
  readonly releasedAt?: Date | string | number | null;
}

export interface ReaderLeaseRegistry {
  getActiveLeases?(
    generation: string,
    at: Date,
  ): Promise<readonly ReaderLease[]> | readonly ReaderLease[];

  listActiveLeases?(
    generation: string,
    at: Date,
  ): Promise<readonly ReaderLease[]> | readonly ReaderLease[];
}

export interface DualWriteGap {
  readonly id: string;
  readonly generation: string;
  readonly sourceVersion: SourceVersion;
  readonly change: SourceChange;
  readonly changeKey: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly lastAttemptAt: string;
  readonly lastError: string;
  readonly resolvedAt?: string;
}

export interface GapJournal {
  append(gap: DualWriteGap): Promise<void> | void;
  list(generation?: string): Promise<readonly DualWriteGap[]> | readonly DualWriteGap[];
  resolve(ids: readonly string[]): Promise<void> | void;
}

export interface BackfillSummary {
  readonly generation: string;
  readonly sourceVersion: SourceVersion;
}

export interface CatchUpSummary {
  readonly fromVersion: SourceVersion;
  readonly throughVersion: SourceVersion;
  readonly appliedChanges: number;
  readonly openGapCount: number;
}

export interface DualWriteResult {
  readonly status: "written" | "gap";
  readonly gap?: DualWriteGap;
}

export interface GapRecoveryResult {
  readonly recoveredGapIds: readonly string[];
  readonly remainingGapIds: readonly string[];
}

export interface SwitchSummary {
  readonly targetGeneration: string;
  readonly previousAliases: AliasSnapshot;
  readonly aliases: AliasSnapshot;
  readonly switchedAt: string;
}

export interface RetainedGeneration {
  readonly generation: string;
  readonly reason:
    | "active-reader-leases"
    | "lease-registry-unavailable"
    | "still-aliased";
  readonly activeLeaseCount?: number;
}

export interface CleanupResult {
  readonly deletedGenerations: readonly string[];
  readonly retainedGenerations: readonly RetainedGeneration[];
}

export interface CoordinationResult extends SwitchSummary {
  readonly backfill: BackfillSummary;
  readonly caughtUpThrough: SourceVersion;
  readonly appliedChanges: number;
  readonly retiredGenerations: readonly string[];
  readonly cleanup: CleanupResult;
}

export interface IndexGenerationCoordinatorOptions {
  readonly backend: IndexGenerationBackend;
  readonly changeFeed: ChangeFeed;
  readonly readerLeases?: ReaderLeaseRegistry;
  readonly gapJournal?: GapJournal;
  readonly targetGeneration?: string;
  readonly pageSize?: number;
  readonly maxCatchUpRounds?: number;
  readonly versionComparator?: SourceVersionComparator;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly beforeSwitch?: (
    context: BackfillSummary & { readonly caughtUpThrough: SourceVersion },
  ) => Promise<void> | void;
}
