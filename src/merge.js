import { CodedError, ERRORS } from './errors.js';

// ---------------------------------------------------------------------------
// Run building: millisecond dedup + consecutive same-state collapse.
// Input events: [{id, utcMs, state, version}]. Observation window [from, to).
// The final run has no closing event: it extends to the observation cutoff
// and is flagged UNCLOSED (pending != unsatisfiable).
// ---------------------------------------------------------------------------
export function buildRuns(events, from, to) {
  if (!(from < to)) {
    throw new CodedError(ERRORS.BAD_COMMAND, `observation window invalid: from=${from} to=${to}`);
  }
  const sorted = [...events].sort((a, b) =>
    a.utcMs - b.utcMs || a.version - b.version || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const logical = []; // [{state, utcMs, ids}]
  let currentState = null;
  for (const ev of sorted) {
    if (ev.utcMs >= to) break;
    if (ev.state === currentState) {
      // duplicate (same ms or later, same state): merge, keep original id
      logical[logical.length - 1].ids.push(ev.id);
    } else {
      currentState = ev.state;
      logical.push({ state: ev.state, utcMs: ev.utcMs, ids: [ev.id] });
    }
  }

  const runs = [];
  for (let i = 0; i < logical.length; i++) {
    const start = logical[i].utcMs;
    const last = i + 1 === logical.length;
    const end = last ? to : logical[i + 1].utcMs;
    if (end <= from) continue;
    runs.push({
      state: logical[i].state,
      start: Math.max(start, from),
      end,
      unclosed: last,
      ids: [...logical[i].ids],
    });
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Period windows: defined by start, duration and end boundary.
// ---------------------------------------------------------------------------
export function periodWindows(period) {
  const { start, durationMs, end } = period ?? {};
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(durationMs)) {
    throw new CodedError(ERRORS.PERIOD_INVERSION,
      'period requires finite start, durationMs and end');
  }
  if (durationMs <= 0) {
    throw new CodedError(ERRORS.PERIOD_INVERSION,
      `period duration must be positive, got ${durationMs}`);
  }
  if (end <= start) {
    throw new CodedError(ERRORS.PERIOD_INVERSION,
      `period end (${end}) must be after start (${start})`);
  }
  const windows = [];
  for (let wStart = start; wStart < end; wStart += durationMs) {
    windows.push({ start: wStart, end: Math.min(wStart + durationMs, end) });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Split runs at period boundaries, then merge adjacent periods that lie inside
// the same maintenance silence window and carry the same state.
// silenceWindows: [{start, end}] (ms, half-open).
// ---------------------------------------------------------------------------
export function segmentByPeriods(runs, windows, silenceWindows = []) {
  const segments = [];
  for (const run of runs) {
    const bounds = new Set([run.start, run.end]);
    for (const w of windows) {
      if (w.start > run.start && w.start < run.end) bounds.add(w.start);
      if (w.end > run.start && w.end < run.end) bounds.add(w.end);
    }
    const pts = [...bounds].sort((a, b) => a - b);
    let firstPiece = true;
    for (let i = 0; i + 1 < pts.length; i++) {
      const s = pts[i], e = pts[i + 1];
      let windowIndex = -1;
      for (let k = 0; k < windows.length; k++) {
        if (windows[k].start <= s && windows[k].end >= e) { windowIndex = k; break; }
      }
      segments.push({
        state: run.state,
        start: s,
        end: e,
        unclosed: run.unclosed && e === run.end,
        // only the first piece of a run carries the original event ids
        ids: firstPiece ? [...run.ids] : [],
        mergedIds: [],
        windowIndex,
        lastWindowIndex: windowIndex,
      });
      firstPiece = false;
    }
  }

  const inSameSilence = (wA, wB) =>
    silenceWindows.some(sw => sw.start <= wA.start && sw.end >= wB.end);

  const merged = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev &&
        prev.state === seg.state &&
        prev.end === seg.start &&
        prev.lastWindowIndex >= 0 &&
        seg.windowIndex === prev.lastWindowIndex + 1 &&
        inSameSilence(windows[prev.lastWindowIndex], windows[seg.windowIndex])) {
      prev.end = seg.end;
      prev.unclosed = seg.unclosed;
      prev.mergedIds.push(...seg.ids);
      prev.lastWindowIndex = seg.windowIndex;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Diff of two run lists (before/after a correction). Returns the affected
// envelope interval plus the elementary change timeline.
// ---------------------------------------------------------------------------
export function diffRuns(beforeRuns, afterRuns) {
  const pts = new Set();
  for (const r of beforeRuns) { pts.add(r.start); pts.add(r.end); }
  for (const r of afterRuns) { pts.add(r.start); pts.add(r.end); }
  const sorted = [...pts].sort((a, b) => a - b);
  const stateAt = (runs, t) => {
    for (const r of runs) if (r.start <= t && t < r.end) return r.state;
    return null;
  };
  const changes = [];
  let affected = null;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const b = stateAt(beforeRuns, sorted[i]);
    const a = stateAt(afterRuns, sorted[i]);
    if (b !== a) {
      changes.push({ from: sorted[i], to: sorted[i + 1], before: b, after: a });
      affected = affected
        ? { from: affected.from, to: sorted[i + 1] }
        : { from: sorted[i], to: sorted[i + 1] };
    }
  }
  return { affected, changes };
}

// Public helper: full merge pipeline for one device.
export function mergeDeviceEvents(events, observe) {
  const { from, to } = observe;
  const runs = buildRuns(events, from, to);
  if (!observe.period) {
    return { runs, intervals: runs.map(r => ({ ...r, mergedIds: [] })) };
  }
  const windows = periodWindows(observe.period);
  const intervals = segmentByPeriods(runs, windows, observe.silence ?? []);
  return { runs, windows, intervals };
}
