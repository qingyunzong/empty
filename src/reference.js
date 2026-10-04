import { FREEZE_LAG_SECONDS } from "./engine.js";

// Reference algorithm: for every batch change, recompute each metric of that
// batch from scratch by brute-force scanning all recorded (non-retracted)
// versions, then diff against the previously emitted status. Records a stage
// snapshot after each event so tests can enumerate results at every stage.
export function runReference(events, options = {}) {
  const freezeLag = options.freezeLag ?? FREEZE_LAG_SECONDS;
  const batches = new Map();
  const metrics = new Map();
  const actions = [];
  const stages = [];
  let watermark = null;

  function isFrozen(metric) {
    return watermark !== null && watermark >= metric.ts + freezeLag;
  }

  // Brute force: scan every recorded version, keep the greatest version's interval.
  function resolveInterval(batchId) {
    const batch = batches.get(batchId);
    if (!batch || batch.retracted) return null;
    let best = null;
    for (const entry of batch.versions) {
      if (best === null || entry.version > best.version) best = entry;
    }
    return best;
  }

  function desiredMatched(metric) {
    const interval = resolveInterval(metric.batchId);
    return interval !== null && metric.ts >= interval.start && metric.ts < interval.end;
  }

  // Recompute every metric of the changed batch and diff against current status.
  function reconcile(batchId, version) {
    for (const metric of metrics.values()) {
      if (metric.batchId !== batchId) continue;
      const next = desiredMatched(metric);
      if (next === metric.matched) continue;
      if (isFrozen(metric)) {
        actions.push({ type: "ACTION", action: "LATE", metricId: metric.metricId, batchId, version, reason: "METRIC_FROZEN" });
        continue;
      }
      metric.matched = next;
      actions.push(next
        ? { type: "ACTION", action: "ADD", metricId: metric.metricId, batchId, status: "MATCHED", version }
        : { type: "ACTION", action: "WITHDRAW", metricId: metric.metricId, batchId, version });
    }
  }

  for (const event of events) {
    if (event.type === "READ_METRIC") {
      const metric = {
        metricId: event.metricId,
        batchId: event.batchId,
        ts: event.ts,
        matched: false,
      };
      metric.matched = desiredMatched(metric);
      metrics.set(metric.metricId, metric);
      const interval = resolveInterval(metric.batchId);
      actions.push({
        type: "ACTION",
        action: "ADD",
        metricId: metric.metricId,
        batchId: metric.batchId,
        status: metric.matched ? "MATCHED" : "UNMATCHED",
        version: interval ? interval.version : null,
      });
    } else if (event.type === "BATCH" && event.op === "UPSERT") {
      let batch = batches.get(event.batchId);
      if (!batch) {
        batch = { versions: [], retracted: false };
        batches.set(event.batchId, batch);
      }
      batch.versions.push({ version: event.version, start: event.start, end: event.end });
      batch.retracted = false;
      reconcile(event.batchId, event.version);
    } else if (event.type === "BATCH" && event.op === "RETRACT") {
      const batch = batches.get(event.batchId);
      if (batch) {
        batch.retracted = true;
        reconcile(event.batchId, event.version ?? null);
      }
    } else if (event.type === "WATERMARK") {
      if (watermark === null || event.ts > watermark) watermark = event.ts;
    }
    const statuses = {};
    for (const metric of metrics.values()) {
      statuses[metric.metricId] = metric.matched ? "MATCHED" : "UNMATCHED";
    }
    stages.push({ watermark, metrics: statuses });
  }

  return { actions, stages };
}
