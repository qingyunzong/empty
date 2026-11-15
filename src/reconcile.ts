import { DeltaFormatError } from "./errors.js";
import type {
  CommitStats,
  DeltaChange,
  EntityRecord,
  ODataEntity,
  ServerVersion,
  VersionComparator,
} from "./types.js";

export type ReconcileAction =
  | "insert"
  | "update"
  | "resurrect"
  | "remove"
  | "ignore";

export type ReconcileReason =
  | "new"
  | "newer-version"
  | "tombstone-tie"
  | "stale-version"
  | "duplicate"
  | "tombstone-wins-tie"
  | "missing-version";

export interface ReconcileOutcome<T extends ODataEntity = ODataEntity> {
  readonly record: EntityRecord<T> | undefined;
  readonly applied: boolean;
  readonly action: ReconcileAction;
  readonly reason: ReconcileReason;
}

export interface ApplyDeltaChangesResult<T extends ODataEntity = ODataEntity> {
  readonly records: Map<string, EntityRecord<T>>;
  readonly stats: CommitStats;
}

function numericVersion(
  value: ServerVersion,
): bigint | number | undefined {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  const text = value.trim();
  const quoted = text.match(/^(?:W\/)?"(\d+)"$/) ?? text.match(/^(?:W\/)?'(\d+)'$/);
  if (quoted !== null) {
    const digits = quoted[1];
    if (digits !== undefined) {
      return BigInt(digits);
    }
  }
  if (/^[+-]?\d+$/.test(text)) {
    return BigInt(text.startsWith("+") ? text.slice(1) : text);
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+)$/.test(text)) {
    return Number(text);
  }
  return undefined;
}

function compareNumeric(
  left: bigint | number,
  right: bigint | number,
): number {
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
}

/**
 * Compares server versions. Integers (including numeric ETags such as
 * `W/"12"`) are compared numerically; all other values use a deterministic
 * code-unit string comparison, which is suitable for ISO-8601 timestamps.
 */
export function compareServerVersions(
  incoming: ServerVersion,
  existing: ServerVersion,
): number {
  if (incoming === existing) {
    return 0;
  }

  const incomingNumber = numericVersion(incoming);
  const existingNumber = numericVersion(existing);
  if (incomingNumber !== undefined && existingNumber !== undefined) {
    return compareNumeric(incomingNumber, existingNumber);
  }

  const left = String(incoming);
  const right = String(existing);
  return left < right ? -1 : left > right ? 1 : 0;
}

function ignored<T extends ODataEntity>(
  current: EntityRecord<T> | undefined,
  reason: ReconcileReason,
): ReconcileOutcome<T> {
  return {
    record: current,
    applied: false,
    action: "ignore",
    reason,
  };
}

function makeRemoval<T extends ODataEntity>(
  change: Extract<DeltaChange<T>, { kind: "removed" }>,
  version: ServerVersion | undefined,
): EntityRecord<T> {
  const base = { id: change.id, deleted: true as const };
  const withVersion =
    version === undefined ? base : { ...base, version };
  return change.reason === undefined
    ? withVersion
    : { ...withVersion, removalReason: change.reason };
}

function makeUpdate<T extends ODataEntity>(
  change: Extract<DeltaChange<T>, { kind: "update" }>,
  version: ServerVersion | undefined,
): EntityRecord<T> {
  const base = { id: change.id, deleted: false as const, entity: change.entity };
  return version === undefined ? base : { ...base, version };
}

/**
 * Applies the version arbitration rule for one entity.
 *
 * - A strictly newer version wins for both updates and tombstones.
 * - At an equal version, a tombstone wins over an update; replaying the same
 *   state is a no-op.
 * - A change without a version is ignored if the stored record has a version,
 *   because it cannot be proven to belong to a later generation.
 * - A tombstone never removes a record with a higher stored version.
 */
export function reconcileChange<T extends ODataEntity = ODataEntity>(
  current: EntityRecord<T> | undefined,
  change: DeltaChange<T>,
  compare: VersionComparator = compareServerVersions,
): ReconcileOutcome<T> {
  if (typeof change.id !== "string" || change.id.trim().length === 0) {
    throw new DeltaFormatError("Delta change has no entity id");
  }
  if (current !== undefined && current.id !== change.id) {
    throw new DeltaFormatError(
      `Delta change id "${change.id}" does not match stored record "${current.id}"`,
    );
  }

  const incomingVersion = change.version;
  const existingVersion = current?.version;
  let equalVersion = false;

  if (existingVersion !== undefined && incomingVersion !== undefined) {
    const order = compare(incomingVersion, existingVersion);
    if (!Number.isFinite(order)) {
      throw new DeltaFormatError(
        "The configured version comparator returned a non-finite value",
      );
    }
    if (order < 0) {
      return ignored(current, "stale-version");
    }
    if (order === 0) {
      equalVersion = true;
      if (change.kind === "removed") {
        if (current === undefined || current.deleted) {
          return ignored(current, "duplicate");
        }
        // Tombstones win ties. The record is alive, so this is a real delete.
      } else if (current !== undefined && current.deleted) {
        return ignored(current, "tombstone-wins-tie");
      } else {
        return ignored(current, "duplicate");
      }
    }
  } else if (existingVersion !== undefined && incomingVersion === undefined) {
    return ignored(current, "missing-version");
  }

  const version = incomingVersion ?? existingVersion;

  if (change.kind === "removed") {
    return {
      record: makeRemoval(change, version),
      applied: true,
      action: "remove",
      reason:
        equalVersion
          ? "tombstone-tie"
          : current === undefined
            ? "new"
            : "newer-version",
    };
  }

  const action: ReconcileAction =
    current === undefined
      ? "insert"
      : current.deleted
        ? "resurrect"
        : "update";

  return {
    record: makeUpdate(change, version),
    applied: true,
    action,
    reason: current === undefined ? "new" : "newer-version",
  };
}

interface MutableCommitStats {
  received: number;
  applied: number;
  ignored: number;
  inserted: number;
  updated: number;
  removed: number;
  resurrected: number;
}

/**
 * Applies a whole round to a copy of `records`. This function is pure: the
 * original map is never mutated, which makes it suitable as the basis of an
 * atomic store transaction.
 */
export function applyDeltaChanges<T extends ODataEntity = ODataEntity>(
  records: ReadonlyMap<string, EntityRecord<T>>,
  changes: readonly DeltaChange<T>[],
  compare: VersionComparator = compareServerVersions,
): ApplyDeltaChangesResult<T> {
  const next = new Map(records);
  const stats: MutableCommitStats = {
    received: changes.length,
    applied: 0,
    ignored: 0,
    inserted: 0,
    updated: 0,
    removed: 0,
    resurrected: 0,
  };

  for (const change of changes) {
    const outcome = reconcileChange(next.get(change.id), change, compare);
    if (!outcome.applied || outcome.record === undefined) {
      stats.ignored += 1;
      continue;
    }

    next.set(change.id, outcome.record);
    stats.applied += 1;
    switch (outcome.action) {
      case "insert":
        stats.inserted += 1;
        break;
      case "update":
        stats.updated += 1;
        break;
      case "resurrect":
        stats.updated += 1;
        stats.resurrected += 1;
        break;
      case "remove":
        stats.removed += 1;
        break;
      case "ignore":
        break;
    }
  }

  return { records: next, stats };
}
