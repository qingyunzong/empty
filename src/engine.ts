import type { Aggregator, FeatureDefinition, FeatureEvent, FeatureResult, PointQuery } from "./types.ts";
import { NO_DEFAULT } from "./types.ts";

/** Built-in aggregator: most recent observed value within the window. */
export const latestValue: Aggregator = (values) => {
  const latest = values[values.length - 1];
  if (latest === undefined) {
    throw new Error("latestValue requires a non-empty event window");
  }
  return latest;
};

/** Built-in aggregator: arithmetic sum of windowed values. */
export const sumValues: Aggregator = (values) => {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
};

/** Built-in aggregator: arithmetic mean of windowed values. */
export const averageValues: Aggregator = (values) => {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
};

/**
 * First index whose `eventTime` is greater than or equal to `target` over an
 * event slice sorted ascending by `eventTime` (binary search, no allocation).
 */
function lowerBoundEventTime(events: readonly FeatureEvent[], target: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midEvent = events[mid];
    if (midEvent === undefined) {
      break;
    }
    if (midEvent.eventTime < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * The single source of truth for feature evaluation.
 *
 * Both the online point lookup path and the offline full backfill path call
 * this exact function on identical (immutable) version materialization, so an
 * online point query and an offline backfill for the same
 * (entity, version, timestamp) are guaranteed to be value-for-value equal.
 */
export async function evaluateFeature(
  definition: FeatureDefinition,
  events: readonly FeatureEvent[],
  query: PointQuery,
): Promise<FeatureResult> {
  const base = {
    featureId: definition.featureId,
    versionId: definition.versionId,
    entityId: query.entityId,
    timestamp: query.timestamp,
  };

  // Time travel outside the version's valid interval is always missing,
  // regardless of events or configured defaults.
  if (query.timestamp < definition.validFrom || query.timestamp > definition.validTo) {
    return { ...base, status: "missing" };
  }

  // Events are pre-filtered by entity and sorted by (eventTime, arrival order).
  const windowStart = query.timestamp - definition.window + 1;
  const startIndex = lowerBoundEventTime(events, windowStart);

  const windowedValues: number[] = [];
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      break;
    }
    if (event.eventTime > query.timestamp) {
      break;
    }
    windowedValues.push(event.value);
  }

  if (windowedValues.length > 0) {
    const value = await definition.aggregate(windowedValues);
    return { ...base, status: "present", value };
  }

  if (definition.defaultValue !== NO_DEFAULT) {
    // Preserve the exact configured value, including 0, NaN, negatives.
    return { ...base, status: "default", value: definition.defaultValue };
  }

  return { ...base, status: "missing" };
}
