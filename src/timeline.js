import { PRIORITY } from './validate.js';

// Sweep-line segmentation: events sorted by start, active set maintained per boundary.
// Intervals are half-open [start, end). Tie-break: higher priority, then smaller id.
export function sweepSegments(events) {
  const pts = [...new Set(events.flatMap((e) => [e.start, e.end]))].sort((a, b) => a - b);
  const sorted = [...events].sort((a, b) => a.start - b.start || a.end - b.end);
  const segs = [];
  let ptr = 0;
  let active = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    while (ptr < sorted.length && sorted[ptr].start <= s) active.push(sorted[ptr++]);
    active = active.filter((ev) => ev.end > s);
    let best = null;
    for (const ev of active) {
      if (
        !best ||
        PRIORITY[ev.type] > PRIORITY[best.type] ||
        (PRIORITY[ev.type] === PRIORITY[best.type] && String(ev.id) < String(best.id))
      ) {
        best = ev;
      }
    }
    segs.push({ start: s, end: e, state: best ? best.type : 'uncovered', sources: best ? [best.id] : [] });
  }
  return segs;
}

export function mergeAdjacent(segs) {
  const out = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.state === seg.state && last.end === seg.start) {
      last.end = seg.end;
      for (const id of seg.sources) if (!last.sources.includes(id)) last.sources.push(id);
    } else {
      out.push({ ...seg, sources: [...seg.sources] });
    }
  }
  return out;
}

// Absorb segments shorter than minSegmentMs into the neighbor with the higher-priority
// state (tie: left). Shortest segment first, leftmost on ties. Repeats to a fixpoint.
export function absorbShort(segs, minSegmentMs) {
  const out = segs.map((s) => ({ ...s, sources: [...s.sources] }));
  for (;;) {
    let idx = -1;
    for (let i = 0; i < out.length; i++) {
      const d = out[i].end - out[i].start;
      if (d < minSegmentMs && (idx === -1 || d < out[idx].end - out[idx].start)) idx = i;
    }
    if (idx === -1 || out.length < 2) return out;
    const left = idx > 0 ? out[idx - 1] : null;
    const right = idx < out.length - 1 ? out[idx + 1] : null;
    const pl = left ? PRIORITY[left.state] : -1;
    const pr = right ? PRIORITY[right.state] : -1;
    const seg = out[idx];
    if (pl >= pr) {
      left.end = seg.end;
      for (const id of seg.sources) if (!left.sources.includes(id)) left.sources.push(id);
    } else {
      right.start = seg.start;
      for (const id of seg.sources) if (!right.sources.includes(id)) right.sources.push(id);
    }
    out.splice(idx, 1);
  }
}

// Label a segment planned/unplanned. Threshold coupling lives here:
// changeover is planned iff its (merged) duration fits the budget.
export function classify(seg, params) {
  const dur = seg.end - seg.start;
  switch (seg.state) {
    case 'run':
      return { ...seg, planned: true, reason: 'run: productive time' };
    case 'maintenance':
      return { ...seg, planned: true, reason: 'maintenance: planned by type' };
    case 'changeover': {
      const ok = dur <= params.changeoverPlannedBudgetMs;
      return {
        ...seg,
        planned: ok,
        reason: `changeover ${dur}ms ${ok ? '<=' : '>'} budget ${params.changeoverPlannedBudgetMs}ms -> ${ok ? 'planned' : 'unplanned'}`,
      };
    }
    case 'idle':
      return { ...seg, planned: false, reason: 'idle: unplanned by rule' };
    case 'fault':
      return { ...seg, planned: false, reason: 'fault: unplanned by rule' };
    default:
      return { ...seg, planned: false, reason: 'uncovered: no event covers this interval' };
  }
}

export function buildTimeline(events, params) {
  const raw = sweepSegments(events);
  const merged = mergeAdjacent(raw);
  const absorbed = mergeAdjacent(absorbShort(merged, params.minSegmentMs));
  return absorbed.map((seg) => classify(seg, params));
}

export function computeOee(timeline, params) {
  if (timeline.length === 0) return null;
  const totalMs = timeline[timeline.length - 1].end - timeline[0].start;
  let plannedDowntimeMs = 0;
  let unplannedDowntimeMs = 0;
  const attribution = {};
  for (const seg of timeline) {
    const d = seg.end - seg.start;
    if (seg.planned) {
      if (seg.state !== 'run') plannedDowntimeMs += d;
    } else {
      unplannedDowntimeMs += d;
      attribution[seg.state] = (attribution[seg.state] || 0) + d;
    }
  }
  const plannedProductionMs = totalMs - plannedDowntimeMs;
  // Convention: if the whole window is planned downtime, availability is 1 (no losses possible).
  const availability = plannedProductionMs > 0 ? (plannedProductionMs - unplannedDowntimeMs) / plannedProductionMs : 1;
  return {
    totalMs,
    plannedDowntimeMs,
    unplannedDowntimeMs,
    plannedProductionMs,
    availability,
    performance: params.performance,
    quality: params.quality,
    oee: availability * params.performance * params.quality,
    attribution,
  };
}
