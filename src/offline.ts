import { evaluateFeature } from "./engine.ts";
import type { VersionHandle } from "./store.ts";
import type { FeatureResult, PointQuery } from "./types.ts";

/**
 * Offline full backfill over a version handle.
 *
 * This deliberately routes every cell through the same `evaluateFeature`
 * function used by online point lookups; the only difference is the set of
 * (entity, timestamp) cells covered. Consequently an online lookup and an
 * offline backfill of the same cell return structurally identical results.
 */
export async function backfillVersion(
  handle: VersionHandle,
  queries: readonly PointQuery[],
): Promise<FeatureResult[]> {
  const results: FeatureResult[] = [];
  for (const query of queries) {
    const events = handle.eventsByEntity.get(query.entityId);
    results.push(
      await evaluateFeature(
        handle.definition,
        events ?? [],
        query,
      ),
    );
  }
  return results;
}

/**
 * Build a full Cartesian backfill grid: every entity queried at every
 * timestamp, in deterministic (entity, timestamp) order.
 */
export function buildBackfillGrid(
  entityIds: readonly string[],
  timestamps: readonly number[],
): PointQuery[] {
  const grid: PointQuery[] = [];
  for (const entityId of entityIds) {
    for (const timestamp of timestamps) {
      grid.push({ entityId, timestamp });
    }
  }
  return grid;
}

/** Stable serialization used to assert value-for-value equality. */
export function resultKey(result: FeatureResult): string {
  if (result.status === "missing") {
    return `${result.versionId}|${result.entityId}|${result.timestamp}|missing`;
  }
  return `${result.versionId}|${result.entityId}|${result.timestamp}|${result.status}|${result.value}`;
}
