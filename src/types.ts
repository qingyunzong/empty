/**
 * Public types for the survivor merge library.
 *
 * A survivor merge is performed independently for every field.  A field can
 * therefore come from one record while another field comes from a different
 * record.
 */

export type SurvivorCriterion =
  | "sourcePriority"
  | "freshness"
  | "completeness"
  | "recordId";

/** Epoch milliseconds, an ISO string, or a Date. */
export type TimestampInput = number | string | Date;

/** One source record participating in an entity merge. */
export interface SurvivorRecord {
  /** Globally stable identifier.  It is the final deterministic tie-breaker. */
  recordId: string;
  sourceId: string;
  values: Readonly<Record<string, unknown>>;
  /** Record-level freshness, normally an ISO date or epoch milliseconds. */
  updatedAt?: TimestampInput;
  /** Optional field-level freshness; falls back to `updatedAt`. */
  fieldUpdatedAt?: Readonly<Record<string, TimestampInput>>;
  /** Optional record-level priority override when no source map is configured. */
  sourcePriority?: number;
  /** Marks this record as withdrawn without needing a separate id list. */
  withdrawn?: boolean;
}

/**
 * Resolves the freshness timestamp for a field.  Returning `null` explicitly
 * means "no timestamp"; the record timestamp is not used as a fallback.
 */
export type FreshnessResolver = (
  record: SurvivorRecord,
  field: string,
) => TimestampInput | null | undefined;

/**
 * Computes a non-negative completeness score.  Higher scores win.  By default
 * the score is derived from the selected value itself (see
 * `defaultCompleteness`).
 */
export type CompletenessScorer = (
  value: unknown,
  record: SurvivorRecord,
  field: string,
) => number;

/** Per-field overrides for the survivorship rules. */
export interface FieldRule {
  /** Field-specific source priority map; overrides the global map. */
  sourcePriorities?: Readonly<Record<string, number>>;
  /** Priority used when neither field nor global maps contain the source. */
  defaultSourcePriority?: number;
  /**
   * Criterion order.  `recordId` is always appended as the final tie-breaker,
   * even if it is omitted here.
   */
  order?: readonly SurvivorCriterion[];
  /** Custom completeness scorer for this field. */
  completeness?: CompletenessScorer;
  /** Custom freshness resolver for this field. */
  freshness?: FreshnessResolver;
  /** Whether empty/blank values may participate in ranking.  Default false. */
  allowEmptyValues?: boolean;
  /** Candidates below this completeness score are excluded.  Default 0. */
  minCompleteness?: number;
}

/** A manual, field-level lock. */
export interface FieldLock {
  /** Required in array form; inferred from the key in map form. */
  field?: string;
  /** The record whose value should survive. */
  recordId?: string;
  /** Only used for provenance/validation when `recordId` is available. */
  sourceId?: string;
  /**
   * An explicit locked value.  When present (even as `undefined`) it is used
   * instead of the value read from `recordId`.
   */
  value?: unknown;
  lockedBy?: string;
  lockedAt?: TimestampInput;
  reason?: string;
}

export type Locks =
  | readonly FieldLock[]
  | Readonly<Record<string, FieldLock>>;

/** Options shared by the entity merge and the single-field selector. */
export interface MergeOptions {
  /** Global source priority map.  Higher numbers win. */
  sourcePriorities?: Readonly<Record<string, number>>;
  /** Priority for sources missing from all configured maps.  Default 0. */
  defaultSourcePriority?: number;
  /** Rules keyed by field name. */
  fieldRules?: Readonly<Record<string, FieldRule>>;
  /** Rule applied to fields without a field-specific rule. */
  defaultFieldRule?: FieldRule;
  locks?: Locks;
  /** Sources treated as withdrawn for this recomputation. */
  withdrawnSources?: Iterable<string>;
  /** Individual records treated as withdrawn for this recomputation. */
  withdrawnRecordIds?: Iterable<string>;
  /** Global default for whether empty values may be selected.  Default false. */
  includeEmptyValues?: boolean;
}

/** Request object accepted by `mergeEntity`/`mergeSurvivor`. */
export interface MergeRequest extends MergeOptions {
  entityId?: string;
  records: readonly SurvivorRecord[];
}

export type ExclusionReason =
  | "source-withdrawn"
  | "record-withdrawn"
  | "empty-value"
  | "below-min-completeness";

export type FreshnessSource = "rule" | "field" | "record" | "none";

/** Evidence retained for every candidate considered for a field. */
export interface CandidateEvidence {
  recordId: string;
  sourceId: string;
  value: unknown;
  sourcePriority: number;
  /** Epoch milliseconds, or null when no valid timestamp exists. */
  freshness: number | null;
  freshnessSource: FreshnessSource;
  completeness: number;
  /** Fraction of populated fields in the whole record (0..1). */
  recordCompleteness: number;
  eligible: boolean;
  excludedReasons: readonly ExclusionReason[];
  /** 1-based rank among eligible candidates, otherwise null. */
  rank: number | null;
}

export interface LockEvidence {
  recordId: string | null;
  sourceId: string | null;
  lockedBy: string | null;
  /** Epoch milliseconds, or null when not supplied/invalid. */
  lockedAt: number | null;
  reason: string | null;
  explicitValue: boolean;
  recordFound: boolean;
  valueFromRecord: boolean;
  /** True when the locked record's source was withdrawn but the lock held. */
  preservedAfterWithdrawal: boolean;
}

export interface FieldEvidence {
  /** Eligible candidates (rank order), followed by excluded candidates. */
  candidates: readonly CandidateEvidence[];
  /** Highest-ranked candidate before applying any manual lock. */
  rankedWinner: CandidateEvidence | null;
  /** Candidate backing the actual selection, if one exists. */
  selected: CandidateEvidence | null;
  /** Best eligible alternative to `selected`. */
  runnerUp: CandidateEvidence | null;
  /** True when only record id separated the top two ranked candidates. */
  tieBreakUsed: boolean;
  ruleOrder: readonly SurvivorCriterion[];
  lock: LockEvidence | null;
  /** True when at least one candidate was removed due to withdrawal. */
  withdrawalAffected: boolean;
}

export interface FieldSelection {
  field: string;
  value: unknown;
  /** False when no record or lock supplied a value for this field. */
  hasValue: boolean;
  recordId: string | null;
  sourceId: string | null;
  decidedBy:
    | SurvivorCriterion
    | "manual-lock"
    | "only-candidate"
    | "no-candidate";
  locked: boolean;
  evidence: FieldEvidence;
}

export interface MergeWarning {
  code:
    | "LOCK_RECORD_NOT_FOUND"
    | "LOCK_SOURCE_MISMATCH"
    | "LOCK_RECORD_WITHDRAWN"
    | "LOCK_SOURCE_WITHDRAWN";
  message: string;
  field: string | null;
  recordId: string | null;
}

export interface RecordSummary {
  recordId: string;
  sourceId: string;
  withdrawn: boolean;
}

export interface EntityMergeResult {
  entityId: string | null;
  /** Selected values.  Fields with no value are omitted. */
  values: Record<string, unknown>;
  /** Field-level selections and evidence, keyed by field name. */
  fields: Record<string, FieldSelection>;
  /** Deterministic field ordering used for serialization. */
  fieldOrder: readonly string[];
  records: readonly RecordSummary[];
  withdrawnSources: readonly string[];
  withdrawnRecordIds: readonly string[];
  lockedFields: readonly string[];
  warnings: readonly MergeWarning[];
  /** True when this invocation supplied or encountered any withdrawal. */
  recomputedAfterWithdrawal: boolean;
}

export class SurvivorMergeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SurvivorMergeError";
    this.code = code;
  }
}
