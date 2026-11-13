import type {
  CandidateEvidence,
  CompletenessScorer,
  EntityMergeResult,
  ExclusionReason,
  FieldEvidence,
  FieldLock,
  FieldSelection,
  FreshnessResolver,
  FreshnessSource,
  LockEvidence,
  Locks,
  MergeOptions,
  MergeRequest,
  MergeWarning,
  RecordSummary,
  SurvivorCriterion,
  SurvivorRecord,
} from "./types.ts";
import { SurvivorMergeError } from "./types.ts";
import {
  compareRecordIds,
  compareScores,
  defaultCompleteness,
  getOwn,
  isEmptyValue,
  parseTimestamp,
  recordCompleteness,
  setOwn,
} from "./values.ts";

const DEFAULT_ORDER: readonly SurvivorCriterion[] = [
  "sourcePriority",
  "freshness",
  "completeness",
];

const CRITERIA: readonly SurvivorCriterion[] = [
  "sourcePriority",
  "freshness",
  "completeness",
  "recordId",
];

const defaultScorer: CompletenessScorer = (value) => defaultCompleteness(value);

interface NormalizedRecord {
  record: SurvivorRecord;
  recordId: string;
  sourceId: string;
  withdrawn: boolean;
  withdrawalReasons: readonly ExclusionReason[];
}

interface NormalizedLock {
  field: string;
  lock: FieldLock;
  explicitValue: boolean;
}

interface ResolvedRule {
  order: readonly SurvivorCriterion[];
  allowEmptyValues: boolean;
  minCompleteness: number;
  completeness: CompletenessScorer;
  freshness: FreshnessResolver | null;
  sourcePriorities: readonly Readonly<Record<string, number>>[];
  defaultSourcePriority: number | null;
}

interface CandidateInternal {
  evidence: CandidateEvidence;
}

interface RankedCandidates {
  all: CandidateInternal[];
  eligible: CandidateInternal[];
  rankedWinner: CandidateInternal | null;
  runnerUp: CandidateInternal | null;
  tieBreakUsed: boolean;
  decidedBy: SurvivorCriterion | "only-candidate" | "no-candidate";
}

function fail(code: string, message: string): never {
  throw new SurvivorMergeError(code, message);
}

function ensureRecord(record: SurvivorRecord, index: number): void {
  if (record === null || typeof record !== "object") {
    fail("INVALID_RECORD", `records[${index}] must be an object`);
  }
  if (
    typeof record.recordId !== "string" ||
    record.recordId.trim().length === 0
  ) {
    fail("INVALID_RECORD", `records[${index}].recordId must be a non-empty string`);
  }
  if (
    typeof record.sourceId !== "string" ||
    record.sourceId.trim().length === 0
  ) {
    fail("INVALID_RECORD", `records[${index}].sourceId must be a non-empty string`);
  }
  if (
    record.values === null ||
    typeof record.values !== "object" ||
    Array.isArray(record.values)
  ) {
    fail("INVALID_RECORD", `records[${index}].values must be an object`);
  }
}

function collectIds(input: Iterable<string> | undefined, name: string): Set<string> {
  if (input === undefined) return new Set<string>();
  if (
    typeof input === "string" ||
    input === null ||
    typeof input !== "object"
  ) {
    fail("INVALID_REQUEST", `${name} must be an iterable of strings`);
  }

  const ids = new Set<string>();
  for (const id of input) {
    if (typeof id !== "string") {
      fail("INVALID_REQUEST", `${name} must contain only strings`);
    }
    ids.add(id);
  }
  return ids;
}

function normalizeRecords(
  records: readonly SurvivorRecord[],
  withdrawnSources: ReadonlySet<string>,
  withdrawnRecordIds: ReadonlySet<string>,
): Map<string, NormalizedRecord> {
  if (!Array.isArray(records)) {
    fail("INVALID_REQUEST", "records must be an array");
  }

  const normalized = new Map<string, NormalizedRecord>();
  records.forEach((record, index) => {
    ensureRecord(record, index);
    if (normalized.has(record.recordId)) {
      fail(
        "DUPLICATE_RECORD_ID",
        `duplicate recordId ${JSON.stringify(record.recordId)}`,
      );
    }

    const reasons: ExclusionReason[] = [];
    if (withdrawnSources.has(record.sourceId)) reasons.push("source-withdrawn");
    if (record.withdrawn === true || withdrawnRecordIds.has(record.recordId)) {
      reasons.push("record-withdrawn");
    }

    normalized.set(record.recordId, {
      record,
      recordId: record.recordId,
      sourceId: record.sourceId,
      withdrawn: reasons.length > 0,
      withdrawalReasons: reasons,
    });
  });

  return normalized;
}

function lockExplicitValue(lock: FieldLock): boolean {
  return Object.hasOwn(lock, "value");
}

function normalizeLocks(locks: Locks | undefined): Map<string, NormalizedLock> {
  const normalized = new Map<string, NormalizedLock>();
  if (locks === undefined) return normalized;

  const add = (lock: FieldLock, keyField?: string): void => {
    if (lock === null || typeof lock !== "object") {
      fail("INVALID_LOCK", "each lock must be an object");
    }
    const field = keyField ?? lock.field;
    if (typeof field !== "string" || field.trim().length === 0) {
      fail("INVALID_LOCK", "each lock requires a non-empty field");
    }
    if (keyField !== undefined && lock.field !== undefined && lock.field !== keyField) {
      fail(
        "INVALID_LOCK",
        `lock for ${JSON.stringify(keyField)} declares field ${JSON.stringify(lock.field)}`,
      );
    }
    if (lock.recordId !== undefined) {
      if (typeof lock.recordId !== "string" || lock.recordId.trim().length === 0) {
        fail("INVALID_LOCK", `lock for ${JSON.stringify(field)} has an invalid recordId`);
      }
    }
    if (lock.sourceId !== undefined) {
      if (typeof lock.sourceId !== "string" || lock.sourceId.trim().length === 0) {
        fail("INVALID_LOCK", `lock for ${JSON.stringify(field)} has an invalid sourceId`);
      }
    }
    const explicitValue = lockExplicitValue(lock);
    if (lock.recordId === undefined && !explicitValue) {
      fail(
        "INVALID_LOCK",
        `lock for ${JSON.stringify(field)} requires recordId or an explicit value`,
      );
    }
    if (normalized.has(field)) {
      fail("DUPLICATE_LOCK", `more than one lock for field ${JSON.stringify(field)}`);
    }
    normalized.set(field, { field, lock, explicitValue });
  };

  if (Array.isArray(locks)) {
    locks.forEach((lock) => add(lock));
  } else if (locks !== null && typeof locks === "object") {
    const lockMap = locks as Readonly<Record<string, FieldLock>>;
    for (const field of Object.keys(lockMap)) {
      add(lockMap[field], field);
    }
  } else {
    fail("INVALID_LOCK", "locks must be an array or a field-keyed object");
  }

  return normalized;
}

function normalizeOrder(
  order: readonly SurvivorCriterion[] | undefined,
): readonly SurvivorCriterion[] {
  const requested = order ?? DEFAULT_ORDER;
  if (!Array.isArray(requested)) {
    fail("INVALID_RULE_ORDER", "rule order must be an array");
  }

  const seen = new Set<SurvivorCriterion>();
  for (const criterion of requested) {
    if (!CRITERIA.includes(criterion)) {
      fail(
        "INVALID_RULE_ORDER",
        `unknown survivorship criterion ${JSON.stringify(criterion)}`,
      );
    }
    if (criterion !== "recordId") seen.add(criterion);
  }
  for (const criterion of DEFAULT_ORDER) {
    seen.add(criterion);
  }

  return [...seen, "recordId"];
}

function resolveRule(
  request: MergeOptions,
  field: string,
): ResolvedRule {
  const fieldRule = getOwn(request.fieldRules, field);
  const defaultRule = request.defaultFieldRule;
  const sourcePriorityMaps: Readonly<Record<string, number>>[] = [];
  if (fieldRule?.sourcePriorities !== undefined) {
    sourcePriorityMaps.push(fieldRule.sourcePriorities);
  }
  if (defaultRule?.sourcePriorities !== undefined) {
    sourcePriorityMaps.push(defaultRule.sourcePriorities);
  }
  if (request.sourcePriorities !== undefined) {
    sourcePriorityMaps.push(request.sourcePriorities);
  }

  let defaultSourcePriority: number | null = null;
  for (const candidate of [
    fieldRule?.defaultSourcePriority,
    defaultRule?.defaultSourcePriority,
    request.defaultSourcePriority,
  ]) {
    if (candidate !== undefined) {
      defaultSourcePriority = candidate;
      break;
    }
  }

  return {
    order: normalizeOrder(fieldRule?.order ?? defaultRule?.order),
    allowEmptyValues:
      fieldRule?.allowEmptyValues ??
      defaultRule?.allowEmptyValues ??
      request.includeEmptyValues ??
      false,
    minCompleteness:
      fieldRule?.minCompleteness ?? defaultRule?.minCompleteness ?? 0,
    completeness:
      fieldRule?.completeness ??
      defaultRule?.completeness ??
      defaultScorer,
    freshness: fieldRule?.freshness ?? defaultRule?.freshness ?? null,
    sourcePriorities: sourcePriorityMaps,
    defaultSourcePriority,
  };
}

function resolveSourcePriority(
  record: SurvivorRecord,
  rule: ResolvedRule,
): number {
  for (const map of rule.sourcePriorities) {
    const configured = getOwn(map, record.sourceId);
    if (configured !== undefined) {
      return Number.isFinite(configured) ? configured : 0;
    }
  }
  if (record.sourcePriority !== undefined) {
    return Number.isFinite(record.sourcePriority) ? record.sourcePriority : 0;
  }
  return rule.defaultSourcePriority ?? 0;
}

function resolveFreshness(
  record: SurvivorRecord,
  field: string,
  rule: ResolvedRule,
): { value: number | null; source: FreshnessSource } {
  if (rule.freshness !== null) {
    const resolved = rule.freshness(record, field);
    return { value: parseTimestamp(resolved ?? null), source: "rule" };
  }

  const fieldTimestamp = getOwn(record.fieldUpdatedAt, field);
  if (fieldTimestamp !== undefined) {
    return { value: parseTimestamp(fieldTimestamp), source: "field" };
  }
  if (record.updatedAt !== undefined) {
    return { value: parseTimestamp(record.updatedAt), source: "record" };
  }
  return { value: null, source: "none" };
}

function scoreCompleteness(
  scorer: CompletenessScorer,
  value: unknown,
  record: SurvivorRecord,
  field: string,
): number {
  const score = scorer(value, record, field);
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return Math.max(0, score);
}

function candidateCompleteness(
  record: SurvivorRecord,
  value: unknown,
  field: string,
  rule: ResolvedRule,
): number {
  return scoreCompleteness(rule.completeness, value, record, field);
}

function compareFreshness(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareScores(right, left);
}

function compareCandidate(
  left: CandidateInternal,
  right: CandidateInternal,
  order: readonly SurvivorCriterion[],
): number {
  for (const criterion of order) {
    let difference = 0;
    if (criterion === "sourcePriority") {
      difference = compareScores(
        right.evidence.sourcePriority,
        left.evidence.sourcePriority,
      );
    } else if (criterion === "freshness") {
      difference = compareFreshness(
        left.evidence.freshness,
        right.evidence.freshness,
      );
    } else if (criterion === "completeness") {
      difference = compareScores(
        right.evidence.completeness,
        left.evidence.completeness,
      );
    } else {
      difference = compareRecordIds(
        left.evidence.recordId,
        right.evidence.recordId,
      );
    }
    if (difference !== 0) return difference;
  }
  return 0;
}

function rankCandidates(
  candidates: CandidateInternal[],
  order: readonly SurvivorCriterion[],
): RankedCandidates {
  const eligible = candidates
    .filter((candidate) => candidate.evidence.eligible)
    .sort((left, right) => compareCandidate(left, right, order));
  const excluded = candidates
    .filter((candidate) => !candidate.evidence.eligible)
    .sort((left, right) =>
      compareRecordIds(left.evidence.recordId, right.evidence.recordId),
    );

  eligible.forEach((candidate, index) => {
    candidate.evidence = {
      ...candidate.evidence,
      rank: index + 1,
    };
  });

  const rankedWinner = eligible[0] ?? null;
  const runnerUp = eligible[1] ?? null;
  let decidedBy: SurvivorCriterion | "only-candidate" | "no-candidate" =
    rankedWinner === null
      ? "no-candidate"
      : runnerUp === null
        ? "only-candidate"
        : "recordId";
  let tieBreakUsed = false;

  if (rankedWinner !== null && runnerUp !== null) {
    const nonIdOrder = order.filter((criterion) => criterion !== "recordId");
    tieBreakUsed =
      compareCandidate(rankedWinner, runnerUp, nonIdOrder) === 0;

    for (const criterion of nonIdOrder) {
      const compared = compareCandidate(rankedWinner, runnerUp, [criterion]);
      if (compared !== 0) {
        decidedBy = criterion;
        break;
      }
    }
  }

  return {
    all: [...eligible, ...excluded],
    eligible,
    rankedWinner,
    runnerUp,
    tieBreakUsed,
    decidedBy,
  };
}

function buildCandidates(
  field: string,
  recordMap: ReadonlyMap<string, NormalizedRecord>,
  rule: ResolvedRule,
): CandidateInternal[] {
  const candidates: CandidateInternal[] = [];

  for (const normalized of recordMap.values()) {
    const record = normalized.record;
    if (!Object.hasOwn(record.values, field)) continue;

    const value = record.values[field];
    const completeness = candidateCompleteness(record, value, field, rule);
    const freshness = resolveFreshness(record, field, rule);
    const reasons: ExclusionReason[] = [...normalized.withdrawalReasons];
    if (!rule.allowEmptyValues && isEmptyValue(value)) {
      reasons.push("empty-value");
    }
    if (completeness < rule.minCompleteness) {
      reasons.push("below-min-completeness");
    }

    candidates.push({
      evidence: {
        recordId: record.recordId,
        sourceId: record.sourceId,
        value,
        sourcePriority: resolveSourcePriority(record, rule),
        freshness: freshness.value,
        freshnessSource: freshness.source,
        completeness,
        recordCompleteness: recordCompleteness(record),
        eligible: reasons.length === 0,
        excludedReasons: reasons,
        rank: null,
      },
    });
  }

  return candidates;
}

function findCandidate(
  candidates: readonly CandidateInternal[],
  recordId: string | null,
): CandidateInternal | null {
  if (recordId === null) return null;
  return candidates.find((candidate) => candidate.evidence.recordId === recordId) ?? null;
}

function lockEvidence(
  normalizedLock: NormalizedLock,
  recordMap: ReadonlyMap<string, NormalizedRecord>,
  warnings: MergeWarning[],
): {
  evidence: LockEvidence;
  value: unknown;
  hasValue: boolean;
  recordId: string | null;
  sourceId: string | null;
} {
  const { field, lock, explicitValue } = normalizedLock;
  const recordId = lock.recordId ?? null;
  const normalizedRecord =
    recordId === null ? undefined : recordMap.get(recordId);
  const record = normalizedRecord?.record ?? null;
  const sourceId = record?.sourceId ?? lock.sourceId ?? null;
  let hasValue = explicitValue;
  let value: unknown = explicitValue ? lock.value : undefined;
  let valueFromRecord = false;
  let preservedAfterWithdrawal = false;

  if (normalizedRecord !== undefined) {
    if (!explicitValue && Object.hasOwn(normalizedRecord.record.values, field)) {
      value = normalizedRecord.record.values[field];
      hasValue = true;
      valueFromRecord = true;
    }

    if (lock.sourceId !== undefined && lock.sourceId !== normalizedRecord.sourceId) {
      warnings.push({
        code: "LOCK_SOURCE_MISMATCH",
        message: `lock for ${JSON.stringify(field)} points at record ${JSON.stringify(recordId)} from source ${JSON.stringify(normalizedRecord.sourceId)}, not ${JSON.stringify(lock.sourceId)}`,
        field,
        recordId,
      });
    }

    if (normalizedRecord.withdrawn) {
      preservedAfterWithdrawal = true;
      warnings.push({
        code: normalizedRecord.withdrawalReasons.includes("source-withdrawn")
          ? "LOCK_SOURCE_WITHDRAWN"
          : "LOCK_RECORD_WITHDRAWN",
        message: `manual lock for ${JSON.stringify(field)} was preserved after withdrawal of record ${JSON.stringify(recordId)}`,
        field,
        recordId,
      });
    }
  } else if (recordId !== null) {
    warnings.push({
      code: "LOCK_RECORD_NOT_FOUND",
      message: `manual lock for ${JSON.stringify(field)} references missing record ${JSON.stringify(recordId)}`,
      field,
      recordId,
    });
  }

  return {
    evidence: {
      recordId,
      sourceId,
      lockedBy: lock.lockedBy ?? null,
      lockedAt: parseTimestamp(lock.lockedAt),
      reason: lock.reason ?? null,
      explicitValue,
      recordFound: record !== null,
      valueFromRecord,
      preservedAfterWithdrawal,
    },
    value,
    hasValue,
    recordId,
    sourceId,
  };
}

function buildFieldSelection(
  field: string,
  recordMap: ReadonlyMap<string, NormalizedRecord>,
  request: MergeOptions,
  lock: NormalizedLock | undefined,
  warnings: MergeWarning[],
): FieldSelection {
  const rule = resolveRule(request, field);
  const candidates = buildCandidates(field, recordMap, rule);
  const ranked = rankCandidates(candidates, rule.order);
  const withdrawalAffected = candidates.some((candidate) =>
    candidate.evidence.excludedReasons.some(
      (reason) =>
        reason === "source-withdrawn" || reason === "record-withdrawn",
    ),
  );

  const baseEvidence: FieldEvidence = {
    candidates: ranked.all.map((candidate) => candidate.evidence),
    rankedWinner: ranked.rankedWinner?.evidence ?? null,
    selected: ranked.rankedWinner?.evidence ?? null,
    runnerUp: ranked.runnerUp?.evidence ?? null,
    tieBreakUsed: ranked.tieBreakUsed,
    ruleOrder: rule.order,
    lock: null,
    withdrawalAffected,
  };

  if (lock === undefined) {
    const winner = ranked.rankedWinner;
    return {
      field,
      value: winner?.evidence.value,
      hasValue: winner !== null,
      recordId: winner?.evidence.recordId ?? null,
      sourceId: winner?.evidence.sourceId ?? null,
      decidedBy: ranked.decidedBy,
      locked: false,
      evidence: baseEvidence,
    };
  }

  const lockResult = lockEvidence(lock, recordMap, warnings);
  const selected = findCandidate(candidates, lockResult.recordId);
  const bestAlternative =
    ranked.eligible.find(
      (candidate) => candidate.evidence.recordId !== lockResult.recordId,
    ) ?? null;

  return {
    field,
    value: lockResult.value,
    hasValue: lockResult.hasValue,
    recordId: lockResult.recordId,
    sourceId: lockResult.sourceId,
    decidedBy: "manual-lock",
    locked: true,
    evidence: {
      ...baseEvidence,
      selected: selected?.evidence ?? null,
      runnerUp: bestAlternative?.evidence ?? null,
      tieBreakUsed: false,
      lock: lockResult.evidence,
    },
  };
}

function discoverFields(
  recordMap: ReadonlyMap<string, NormalizedRecord>,
  locks: ReadonlyMap<string, NormalizedLock>,
): string[] {
  const fields = new Set<string>();
  for (const normalized of recordMap.values()) {
    for (const field of Object.keys(normalized.record.values)) {
      fields.add(field);
    }
  }
  for (const field of locks.keys()) {
    fields.add(field);
  }
  return [...fields].sort(compareRecordIds);
}

function splitLocks(locks: Locks | undefined): Map<string, NormalizedLock> {
  return normalizeLocks(locks);
}

function sortedWarnings(warnings: MergeWarning[]): MergeWarning[] {
  return [...warnings].sort((left, right) => {
    const code = compareRecordIds(left.code, right.code);
    if (code !== 0) return code;
    const field = compareRecordIds(left.field ?? "", right.field ?? "");
    if (field !== 0) return field;
    return compareRecordIds(left.recordId ?? "", right.recordId ?? "");
  });
}

function normalizeRequest(request: MergeRequest): {
  entityId: string | null;
  records: readonly SurvivorRecord[];
  options: MergeOptions;
} {
  if (request === null || typeof request !== "object") {
    fail("INVALID_REQUEST", "merge request must be an object");
  }
  if (request.entityId !== undefined && typeof request.entityId !== "string") {
    fail("INVALID_REQUEST", "entityId must be a string when supplied");
  }
  return {
    entityId: request.entityId ?? null,
    records: request.records,
    options: request,
  };
}

export function mergeEntity(request: MergeRequest): EntityMergeResult;
export function mergeEntity(
  records: readonly SurvivorRecord[],
  options?: MergeOptions,
): EntityMergeResult;
export function mergeEntity(
  entityId: string,
  records: readonly SurvivorRecord[],
  options?: MergeOptions,
): EntityMergeResult;
export function mergeEntity(
  requestOrRecordsOrEntity:
    | MergeRequest
    | readonly SurvivorRecord[]
    | string,
  recordsOrOptions?: readonly SurvivorRecord[] | MergeOptions,
  maybeOptions?: MergeOptions,
): EntityMergeResult {
  let entityId: string | null = null;
  let records: readonly SurvivorRecord[];
  let options: MergeOptions;

  if (typeof requestOrRecordsOrEntity === "string") {
    entityId = requestOrRecordsOrEntity;
    if (!Array.isArray(recordsOrOptions)) {
      fail("INVALID_REQUEST", "records must be supplied after entityId");
    }
    records = recordsOrOptions;
    options = maybeOptions ?? {};
  } else if (Array.isArray(requestOrRecordsOrEntity)) {
    records = requestOrRecordsOrEntity;
    options = (recordsOrOptions as MergeOptions | undefined) ?? {};
  } else {
    const normalized = normalizeRequest(
      requestOrRecordsOrEntity as MergeRequest,
    );
    entityId = normalized.entityId;
    records = normalized.records;
    options = normalized.options;
  }

  const withdrawnSources = collectIds(
    options.withdrawnSources,
    "withdrawnSources",
  );
  const withdrawnRecordIds = collectIds(
    options.withdrawnRecordIds,
    "withdrawnRecordIds",
  );
  const recordMap = normalizeRecords(records, withdrawnSources, withdrawnRecordIds);
  const locks = splitLocks(options.locks);
  const fields = discoverFields(recordMap, locks);
  const warnings: MergeWarning[] = [];
  const values: Record<string, unknown> = {};
  const fieldSelections: Record<string, FieldSelection> = {};

  for (const field of fields) {
    const selection = buildFieldSelection(
      field,
      recordMap,
      options,
      locks.get(field),
      warnings,
    );
    setOwn(fieldSelections, field, selection);
    if (selection.hasValue) setOwn(values, field, selection.value);
  }

  const recordSummaries: RecordSummary[] = [...recordMap.values()]
    .map((normalized) => ({
      recordId: normalized.recordId,
      sourceId: normalized.sourceId,
      withdrawn: normalized.withdrawn,
    }))
    .sort((left, right) => compareRecordIds(left.recordId, right.recordId));

  const recomputedAfterWithdrawal =
    withdrawnSources.size > 0 ||
    withdrawnRecordIds.size > 0 ||
    [...recordMap.values()].some((normalized) => normalized.withdrawn);

  return {
    entityId,
    values,
    fields: fieldSelections,
    fieldOrder: fields,
    records: recordSummaries,
    withdrawnSources: [...withdrawnSources].sort(compareRecordIds),
    withdrawnRecordIds: [...withdrawnRecordIds].sort(compareRecordIds),
    lockedFields: [...locks.keys()]
      .map((field) => field)
      .sort(compareRecordIds),
    warnings: sortedWarnings(warnings),
    recomputedAfterWithdrawal,
  };
}

/**
 * Selects one field.  This is the same logic used by `mergeEntity`, exposed for
 * callers that merge fields incrementally or need to audit one field only.
 */
export function selectField(
  field: string,
  records: readonly SurvivorRecord[],
  options: MergeOptions = {},
): FieldSelection {
  if (typeof field !== "string" || field.trim().length === 0) {
    fail("INVALID_REQUEST", "field must be a non-empty string");
  }

  const withdrawnSources = collectIds(
    options.withdrawnSources,
    "withdrawnSources",
  );
  const withdrawnRecordIds = collectIds(
    options.withdrawnRecordIds,
    "withdrawnRecordIds",
  );
  const recordMap = normalizeRecords(records, withdrawnSources, withdrawnRecordIds);
  const locks = splitLocks(options.locks);
  const warnings: MergeWarning[] = [];
  return buildFieldSelection(
    field,
    recordMap,
    options,
    locks.get(field),
    warnings,
  );
}

/** Request-style alias for `mergeEntity`. */
export const mergeSurvivor: typeof mergeEntity = mergeEntity;

/** Convenience alias for `mergeEntity`. */
export const mergeRecords: typeof mergeEntity = mergeEntity;
