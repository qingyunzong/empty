export const FREEZE_LAG_SECONDS = 30;

export function createEngine(options = {}) {
  const freezeLag = options.freezeLag ?? FREEZE_LAG_SECONDS;
  const batches = new Map();
  const metrics = new Map();
  const log = [];
  let watermark = null;

  function isFrozen(metric) {
    return watermark !== null && watermark >= metric.ts + freezeLag;
  }

  function currentInterval(batch) {
    if (!batch || batch.retracted) return null;
    return batch.versions.get(batch.currentVersion) ?? null;
  }

  function computeMatched(metric) {
    const interval = currentInterval(batches.get(metric.batchId));
    return interval !== null && metric.ts >= interval.start && metric.ts < interval.end;
  }

  function emit(action) {
    log.push(action);
    return action;
  }

  function rematchMetric(metric, batchId, version, push) {
    const next = computeMatched(metric);
    if (next === metric.matched) return;
    if (isFrozen(metric)) {
      push({ type: "ACTION", action: "LATE", metricId: metric.metricId, batchId, version, reason: "METRIC_FROZEN" });
      return;
    }
    metric.matched = next;
    push(next
      ? { type: "ACTION", action: "ADD", metricId: metric.metricId, batchId, status: "MATCHED", version }
      : { type: "ACTION", action: "WITHDRAW", metricId: metric.metricId, batchId, version });
  }

  function handleReadMetric(event, push) {
    const { metricId, batchId, ts } = event;
    const quality = event.quality;
    if (typeof quality !== "number" || Number.isNaN(quality) || quality < 0 || quality > 1) {
      push({ type: "ACTION", action: "INVALID_QUALITY", metricId, batchId });
      return;
    }
    const metric = { metricId, batchId, ts, yield: event.yield, quality, matched: false };
    metric.matched = computeMatched(metric);
    metrics.set(metricId, metric);
    const batch = batches.get(batchId);
    push({
      type: "ACTION",
      action: "ADD",
      metricId,
      batchId,
      status: metric.matched ? "MATCHED" : "UNMATCHED",
      version: batch && !batch.retracted ? batch.currentVersion : null,
    });
  }

  function handleBatchUpsert(event, push) {
    const { batchId, start, end, version } = event;
    if (!(typeof start === "number" && typeof end === "number") || end <= start) {
      push({ type: "ACTION", action: "INVALID_RANGE", batchId, version, start, end });
      return;
    }
    let batch = batches.get(batchId);
    if (batch && version <= batch.currentVersion) {
      push({ type: "ACTION", action: "STALE_VERSION", batchId, version, currentVersion: batch.currentVersion });
      return;
    }
    if (!batch) {
      batch = { batchId, versions: new Map(), currentVersion: null, retracted: false };
      batches.set(batchId, batch);
    }
    batch.versions.set(version, { start, end });
    batch.currentVersion = version;
    batch.retracted = false;
    for (const metric of metrics.values()) {
      if (metric.batchId === batchId) rematchMetric(metric, batchId, version, push);
    }
  }

  function handleBatchRetract(event, push) {
    const { batchId, version } = event;
    const batch = batches.get(batchId);
    if (!batch) {
      push({ type: "ACTION", action: "UNKNOWN_RETRACT", batchId, version });
      return;
    }
    if (typeof version === "number" && version <= batch.currentVersion) {
      push({ type: "ACTION", action: "STALE_VERSION", batchId, version, currentVersion: batch.currentVersion });
      return;
    }
    batch.retracted = true;
    if (typeof version === "number") batch.currentVersion = version;
    for (const metric of metrics.values()) {
      if (metric.batchId === batchId) rematchMetric(metric, batchId, version ?? null, push);
    }
  }

  function processEvent(event) {
    const emitted = [];
    const push = (action) => emitted.push(emit(action));
    switch (event?.type) {
      case "READ_METRIC":
        handleReadMetric(event, push);
        break;
      case "BATCH":
        if (event.op === "UPSERT") handleBatchUpsert(event, push);
        else if (event.op === "RETRACT") handleBatchRetract(event, push);
        else push({ type: "ACTION", action: "UNKNOWN_OP", batchId: event.batchId, op: event.op ?? null });
        break;
      case "WATERMARK":
        if (typeof event.ts === "number" && (watermark === null || event.ts > watermark)) {
          watermark = event.ts;
        }
        break;
      default:
        push({ type: "ACTION", action: "UNKNOWN_EVENT", eventType: event?.type ?? null });
    }
    return emitted;
  }

  function snapshot() {
    const statuses = {};
    for (const metric of metrics.values()) {
      statuses[metric.metricId] = metric.matched ? "MATCHED" : "UNMATCHED";
    }
    return { watermark, metrics: statuses };
  }

  function certificate() {
    const batchList = [...batches.values()].map((batch) => ({
      batchId: batch.batchId,
      version: batch.currentVersion,
      retracted: batch.retracted,
      versions: [...batch.versions.keys()].sort((a, b) => a - b),
      matched: [...metrics.values()].filter((m) => m.batchId === batch.batchId && m.matched).length,
    }));
    const metricList = [...metrics.values()].map((metric) => ({
      metricId: metric.metricId,
      batchId: metric.batchId,
      status: metric.matched ? "MATCHED" : "UNMATCHED",
      frozen: isFrozen(metric),
    }));
    const matched = metricList.filter((m) => m.status === "MATCHED").length;
    return {
      type: "CERTIFICATE",
      watermark,
      batches: batchList,
      metrics: metricList,
      counts: {
        batches: batchList.length,
        metrics: metricList.length,
        matched,
        unmatched: metricList.length - matched,
      },
    };
  }

  return {
    processEvent,
    certificate,
    snapshot,
    get log() { return log.slice(); },
    get watermark() { return watermark; },
  };
}
