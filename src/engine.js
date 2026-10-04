// Incremental streaming engine joining READ_METRIC events to BATCH intervals.
//
// Semantics:
// - A metric joins a batch when its ts falls inside the batch's current
//   half-open interval [start, end).
// - Batch UPSERTs carry a monotonically increasing version per batchId; every
//   version's interval is kept in history. A version <= current is rejected
//   with STALE_VERSION.
// - A metric freezes once the common WATERMARK passes ts + FREEZE_AFTER_SECONDS.
//   Batch corrections/retractions that would migrate a frozen metric are
//   rejected per metric with a LATE error; unfrozen metrics still migrate.
// - Migrations emit ADD (UNMATCHED -> MATCHED) and WITHDRAW (MATCHED ->
//   UNMATCHED) actions.

export const FREEZE_AFTER_SECONDS = 30;

export function createEngine() {
  const batches = new Map(); // batchId -> { currentVersion, start, end, retracted, history: [{version, start, end}] }
  const metrics = new Map(); // metricId -> { metricId, batchId, ts, yield, quality, state }
  let watermark = null;
  const counts = { add: 0, withdraw: 0, unmatched: 0, error: 0 };

  function isFrozen(metric) {
    return watermark !== null && watermark > metric.ts + FREEZE_AFTER_SECONDS;
  }

  function emit(actions, action) {
    if (action.action === 'ADD') counts.add += 1;
    else if (action.action === 'WITHDRAW') counts.withdraw += 1;
    else if (action.action === 'UNMATCHED') counts.unmatched += 1;
    else if (action.action === 'ERROR') counts.error += 1;
    actions.push(action);
  }

  function fail(actions, code, details) {
    emit(actions, { action: 'ERROR', code, ...details });
  }

  function handleBatchUpsert(event, actions) {
    const { batchId, version, start, end } = event;
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
      fail(actions, 'INVALID_RANGE', { batchId, version, start, end });
      return;
    }
    const batch = batches.get(batchId);
    if (batch && version <= batch.currentVersion) {
      fail(actions, 'STALE_VERSION', { batchId, version, currentVersion: batch.currentVersion });
      return;
    }
    if (batch) {
      batch.currentVersion = version;
      batch.start = start;
      batch.end = end;
      batch.retracted = false;
      batch.history.push({ version, start, end });
    } else {
      batches.set(batchId, {
        currentVersion: version,
        start,
        end,
        retracted: false,
        history: [{ version, start, end }],
      });
    }
    for (const metric of metrics.values()) {
      if (metric.batchId !== batchId) continue;
      const matched = metric.ts >= start && metric.ts < end;
      const next = matched ? 'MATCHED' : 'UNMATCHED';
      if (next === metric.state) continue;
      if (isFrozen(metric)) {
        fail(actions, 'LATE', { batchId, metricId: metric.metricId, version });
        continue;
      }
      metric.state = next;
      emit(actions, matched
        ? { action: 'ADD', metricId: metric.metricId, batchId, version }
        : { action: 'WITHDRAW', metricId: metric.metricId, batchId, version });
    }
  }

  function handleBatchRetract(event, actions) {
    const { batchId } = event;
    const batch = batches.get(batchId);
    if (!batch) {
      fail(actions, 'UNKNOWN_RETRACT', { batchId });
      return;
    }
    batch.retracted = true;
    for (const metric of metrics.values()) {
      if (metric.batchId !== batchId || metric.state !== 'MATCHED') continue;
      if (isFrozen(metric)) {
        fail(actions, 'LATE', { batchId, metricId: metric.metricId, version: batch.currentVersion });
        continue;
      }
      metric.state = 'UNMATCHED';
      emit(actions, { action: 'WITHDRAW', metricId: metric.metricId, batchId, version: batch.currentVersion });
    }
  }

  function handleMetric(event, actions) {
    const { metricId, batchId, ts, quality } = event;
    if (typeof quality !== 'number' || Number.isNaN(quality) || quality < 0 || quality > 1) {
      fail(actions, 'INVALID_QUALITY', { metricId, batchId, quality });
      return;
    }
    const batch = batches.get(batchId);
    const matched = Boolean(batch) && !batch.retracted && ts >= batch.start && ts < batch.end;
    metrics.set(metricId, {
      metricId,
      batchId,
      ts,
      yield: event.yield,
      quality,
      state: matched ? 'MATCHED' : 'UNMATCHED',
    });
    emit(actions, matched
      ? { action: 'ADD', metricId, batchId, version: batch.currentVersion }
      : { action: 'UNMATCHED', metricId, batchId });
  }

  function process(event) {
    const actions = [];
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      fail(actions, 'INVALID_EVENT', { event: null });
      return actions;
    }
    switch (event.type) {
      case 'BATCH':
        if (event.op === 'RETRACT') handleBatchRetract(event, actions);
        else handleBatchUpsert(event, actions);
        break;
      case 'READ_METRIC':
        handleMetric(event, actions);
        break;
      case 'WATERMARK':
        if (typeof event.ts === 'number' && (watermark === null || event.ts > watermark)) {
          watermark = event.ts;
        }
        break;
      default:
        fail(actions, 'UNKNOWN_EVENT', { type: event.type });
    }
    return actions;
  }

  function certificate() {
    const batchList = [...batches.entries()].map(([batchId, batch]) => ({
      batchId,
      version: batch.currentVersion,
      retracted: batch.retracted,
      interval: { start: batch.start, end: batch.end },
      versions: batch.history.map((h) => h.version),
    }));
    const metricList = [...metrics.values()].map((metric) => ({
      metricId: metric.metricId,
      batchId: metric.batchId,
      ts: metric.ts,
      state: metric.state,
      frozen: isFrozen(metric),
    }));
    return {
      type: 'CERTIFICATE',
      watermark,
      freezeAfterSeconds: FREEZE_AFTER_SECONDS,
      batches: batchList,
      metrics: metricList,
      counts: {
        batches: batchList.length,
        metrics: metricList.length,
        matched: metricList.filter((m) => m.state === 'MATCHED').length,
        unmatched: metricList.filter((m) => m.state === 'UNMATCHED').length,
        add: counts.add,
        withdraw: counts.withdraw,
        error: counts.error,
      },
    };
  }

  return { process, certificate };
}
