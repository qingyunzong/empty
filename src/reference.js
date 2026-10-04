// Brute-force reference implementation used to validate the incremental engine.
//
// For every metric and every stage of the event stream it rescans ALL batch
// versions/retractions seen so far, keeping only those that arrived while the
// metric was still unfrozen (watermark before the batch event <= ts + 30s),
// and derives the metric state from the latest applicable one. Actions are the
// observed transitions, enumerated stage by stage. This is intentionally
// O(events^2 * metrics) and only suitable for small event sets.

import { FREEZE_AFTER_SECONDS } from './engine.js';

export function referenceRun(events) {
  // Watermark in effect before each event index.
  const watermarkBefore = new Array(events.length).fill(null);
  let wm = null;
  for (let i = 0; i < events.length; i += 1) {
    watermarkBefore[i] = wm;
    const e = events[i];
    if (e && e.type === 'WATERMARK' && typeof e.ts === 'number' && (wm === null || e.ts > wm)) {
      wm = e.ts;
    }
  }
  const frozenAt = (metric, index) =>
    watermarkBefore[index] !== null && watermarkBefore[index] > metric.ts + FREEZE_AFTER_SECONDS;

  // Replay validation to collect only the batch events that actually applied.
  const applied = []; // { index, batchId, kind: 'upsert'|'retract', version, start, end }
  const currentVersion = new Map();
  events.forEach((e, i) => {
    if (!e || e.type !== 'BATCH') return;
    if (e.op === 'RETRACT') {
      if (!currentVersion.has(e.batchId)) return; // UNKNOWN_RETRACT
      applied.push({ index: i, batchId: e.batchId, kind: 'retract' });
      return;
    }
    if (typeof e.start !== 'number' || typeof e.end !== 'number' || e.end <= e.start) return; // INVALID_RANGE
    const cur = currentVersion.get(e.batchId);
    if (cur !== undefined && e.version <= cur) return; // STALE_VERSION
    currentVersion.set(e.batchId, e.version);
    applied.push({ index: i, batchId: e.batchId, kind: 'upsert', version: e.version, start: e.start, end: e.end });
  });

  // Valid metrics by arrival index.
  const metrics = [];
  const metricAt = new Map();
  events.forEach((e, i) => {
    if (!e || e.type !== 'READ_METRIC') return;
    if (typeof e.quality !== 'number' || Number.isNaN(e.quality) || e.quality < 0 || e.quality > 1) return;
    const m = { index: i, metricId: e.metricId, batchId: e.batchId, ts: e.ts };
    metrics.push(m);
    metricAt.set(i, m);
  });

  // A batch event applies to a metric if it predates the metric, or the metric
  // was still unfrozen when the batch event arrived.
  const appliesTo = (h, m) => h.index < m.index || !frozenAt(m, h.index);

  // Brute-force metric state after the first `stage` events: scan every
  // applied batch version/retraction and keep the latest applicable one.
  function stateAtStage(m, stage) {
    let last = null;
    for (const h of applied) {
      if (h.batchId !== m.batchId || h.index >= stage) continue;
      if (appliesTo(h, m)) last = h;
    }
    if (!last || last.kind === 'retract') return 'UNMATCHED';
    return m.ts >= last.start && m.ts < last.end ? 'MATCHED' : 'UNMATCHED';
  }

  const actions = [];
  const liveState = new Map();

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    const arriving = metricAt.get(i);
    if (arriving) {
      const state = stateAtStage(arriving, i + 1);
      liveState.set(arriving.metricId, state);
      actions.push(state === 'MATCHED'
        ? { action: 'ADD', metricId: arriving.metricId, batchId: arriving.batchId }
        : { action: 'UNMATCHED', metricId: arriving.metricId, batchId: arriving.batchId });
      continue;
    }
    if (!e || e.type !== 'BATCH') continue;
    const h = applied.find((a) => a.index === i);
    if (!h) continue; // rejected batch events produce ERROR actions, tested separately
    for (const m of metrics) {
      if (m.batchId !== e.batchId || m.index >= i) continue;
      const before = liveState.get(m.metricId);
      const after = stateAtStage(m, i + 1);
      if (after !== before) {
        liveState.set(m.metricId, after);
        actions.push({ action: after === 'MATCHED' ? 'ADD' : 'WITHDRAW', metricId: m.metricId, batchId: m.batchId });
      } else if (frozenAt(m, i)) {
        // Frozen: the correction is rejected with LATE only if it would have
        // changed the metric's state.
        const hypo = h.kind === 'retract'
          ? 'UNMATCHED'
          : (m.ts >= h.start && m.ts < h.end ? 'MATCHED' : 'UNMATCHED');
        if (hypo !== before) {
          actions.push({ action: 'ERROR', code: 'LATE', metricId: m.metricId, batchId: m.batchId });
        }
      }
    }
  }

  return { actions, finalStates: liveState };
}
