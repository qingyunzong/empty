'use strict';

const { createHash } = require('node:crypto');
const { DomainError, toIso, normalizeEvent, normalizeShift } = require('./validate');

function compareIntervals(a, b) {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.endMs !== b.endMs) return a.endMs - b.endMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function lowerBound(arr, item, cmp) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(arr[mid], item) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function serializeSession(s) {
  return {
    state: s.state,
    start: toIso(s.startMs),
    end: toIso(s.endMs),
    durationMs: s.endMs - s.startMs,
    sources: s.sourceIds.slice(),
  };
}

class Store {
  constructor(shifts = []) {
    this.shifts = shifts
      .map(normalizeShift)
      .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
    this.metrics = new Map(this.shifts.map((s) => [s.id, { runMs: 0, failMs: 0 }]));
    this.intervals = [];
    this.sessions = [];
    this.byId = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.counter = 0;
  }

  // ---- interval chain helpers -------------------------------------------------

  _chainLo(index) {
    const ivs = this.intervals;
    let i = index;
    while (i > 0 && ivs[i - 1].state === ivs[i].state && ivs[i - 1].endMs === ivs[i].startMs) i -= 1;
    return ivs[i].startMs;
  }

  _chainHi(index) {
    const ivs = this.intervals;
    let i = index;
    while (i < ivs.length - 1 && ivs[i + 1].state === ivs[i].state && ivs[i + 1].startMs === ivs[i].endMs) i += 1;
    return ivs[i].endMs;
  }

  _windowAround(indices, extra) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const idx of indices) {
      if (idx < 0 || idx >= this.intervals.length) continue;
      lo = Math.min(lo, this._chainLo(idx));
      hi = Math.max(hi, this._chainHi(idx));
    }
    if (extra) {
      lo = Math.min(lo, extra[0]);
      hi = Math.max(hi, extra[1]);
    }
    return [lo, hi];
  }

  // ---- incremental session rebuild ---------------------------------------------

  _rebuild(lo, hi) {
    // sessions intersecting [lo, hi)
    let sLo = lowerBound(this.sessions, { endMs: lo }, (a, b) => a.endMs - b.endMs);
    while (sLo < this.sessions.length && this.sessions[sLo].endMs <= lo) sLo += 1;
    let sHi = sLo;
    while (sHi < this.sessions.length && this.sessions[sHi].startMs < hi) sHi += 1;
    const removed = this.sessions.slice(sLo, sHi);

    // intervals inside [lo, hi); window edges align with interval boundaries
    const iLo = lowerBound(this.intervals, { startMs: lo, endMs: 0, id: '' }, compareIntervals);
    const added = [];
    let cur = null;
    for (let i = iLo; i < this.intervals.length && this.intervals[i].startMs < hi; i += 1) {
      const iv = this.intervals[i];
      if (cur && cur.state === iv.state && cur.endMs === iv.startMs) {
        cur.endMs = iv.endMs;
        cur.sourceIds.push(iv.id);
      } else {
        if (cur) added.push(cur);
        cur = { state: iv.state, startMs: iv.startMs, endMs: iv.endMs, sourceIds: [iv.id] };
      }
    }
    if (cur) added.push(cur);

    this.sessions.splice(sLo, removed.length, ...added);
    for (const s of removed) this._applyMetrics(s, -1);
    for (const s of added) this._applyMetrics(s, +1);
    return { removed, added };
  }

  _applyMetrics(session, sign) {
    if (session.state !== 'RUN' && session.state !== 'FAIL') return;
    for (const shift of this.shifts) {
      if (shift.startMs >= session.endMs) break;
      const overlap = Math.min(session.endMs, shift.endMs) - Math.max(session.startMs, shift.startMs);
      if (overlap <= 0) continue;
      const m = this.metrics.get(shift.id);
      if (session.state === 'RUN') m.runMs += sign * overlap;
      else m.failMs += sign * overlap;
    }
  }

  _shiftSnapshot(lo, hi) {
    const snap = new Map();
    for (const shift of this.shifts) {
      if (shift.endMs <= lo) continue;
      if (shift.startMs >= hi) break;
      const m = this.metrics.get(shift.id);
      snap.set(shift.id, { runMs: m.runMs, failMs: m.failMs });
    }
    return snap;
  }

  _shiftView(shiftId) {
    const shift = this.shifts.find((s) => s.id === shiftId);
    const m = this.metrics.get(shiftId);
    const span = shift.endMs - shift.startMs;
    return {
      runMs: m.runMs,
      failMs: m.failMs,
      availability: span > 0 ? round6(m.runMs / span) : null,
    };
  }

  _mutate(info, lo, hi) {
    const before = this._shiftSnapshot(lo, hi);
    const { removed, added } = this._rebuild(lo, hi);
    const shiftDiffs = [];
    for (const [shiftId, prev] of before) {
      const next = this._shiftView(shiftId);
      if (next.runMs !== prev.runMs || next.failMs !== prev.failMs) {
        const span = this.shifts.find((s) => s.id === shiftId);
        shiftDiffs.push({
          id: shiftId,
          before: { ...prev, availability: round6(prev.runMs / (span.endMs - span.startMs)) },
          after: next,
        });
      }
    }
    return {
      ...info,
      removedSessions: removed.map(serializeSession),
      addedSessions: added.map(serializeSession),
      shifts: shiftDiffs,
    };
  }

  // ---- mutations -----------------------------------------------------------------

  _insertInterval(iv) {
    if (this.byId.has(iv.id)) {
      throw new DomainError('DUPLICATE_ID', `duplicate event id "${iv.id}"`, { id: iv.id });
    }
    const pos = lowerBound(this.intervals, iv, compareIntervals);
    const prev = this.intervals[pos - 1];
    const next = this.intervals[pos];
    if ((prev && prev.endMs > iv.startMs) || (next && iv.endMs > next.startMs)) {
      const other = prev && prev.endMs > iv.startMs ? prev : next;
      throw new DomainError('OVERLAP', `event "${iv.id}" overlaps existing event "${other.id}"`, { id: iv.id, overlaps: other.id });
    }
    this.intervals.splice(pos, 0, iv);
    this.byId.set(iv.id, iv);
    return pos;
  }

  _removeInterval(id) {
    const iv = this.byId.get(id);
    if (!iv) {
      throw new DomainError('UNKNOWN_ID', `no event with id "${id}"`, { id });
    }
    const pos = lowerBound(this.intervals, iv, compareIntervals);
    this.intervals.splice(pos, 1);
    this.byId.delete(id);
    return { iv, pos };
  }

  _doAppend(rawEvent, recordTo) {
    const iv = normalizeEvent(rawEvent, `e${++this.counter}`);
    const pos = this._insertInterval(iv);
    const [lo, hi] = this._windowAround([pos - 1, pos, pos + 1]);
    const diff = this._mutate({ op: 'append', id: iv.id }, lo, hi);
    if (recordTo) recordTo.push({ type: 'delete', id: iv.id });
    return diff;
  }

  _doDelete(id, recordTo) {
    const { iv, pos } = this._removeInterval(String(id));
    const [lo, hi] = this._windowAround([pos - 1, pos], [iv.startMs, iv.endMs]);
    const diff = this._mutate({ op: 'delete', id: iv.id }, lo, hi);
    if (recordTo) recordTo.push({ type: 'append', event: eventToJson(iv) });
    return diff;
  }

  _doCorrect(id, rawEvent, recordTo) {
    const key = String(id);
    const old = this.byId.get(key);
    if (!old) {
      throw new DomainError('UNKNOWN_ID', `no event with id "${key}"`, { id: key });
    }
    const { pos: oldPos } = this._removeInterval(key);
    let iv;
    try {
      iv = normalizeEvent({ ...rawEvent, id: key }, key);
    } catch (err) {
      this._insertInterval(old);
      throw err;
    }
    let newPos;
    try {
      newPos = this._insertInterval(iv);
    } catch (err) {
      this._insertInterval(old);
      throw err;
    }
    const [lo1, hi1] = this._windowAround([oldPos - 1, oldPos], [old.startMs, old.endMs]);
    const [lo2, hi2] = this._windowAround([newPos - 1, newPos, newPos + 1]);
    const diff = this._mutate({ op: 'correct', id: key }, Math.min(lo1, lo2), Math.max(hi1, hi2));
    if (recordTo) recordTo.push({ type: 'correct', id: key, event: eventToJson(old) });
    return diff;
  }

  // ---- public command API ---------------------------------------------------------

  append(event) {
    this.redoStack = [];
    return this._doAppend(event, this.undoStack);
  }

  delete(id) {
    this.redoStack = [];
    return this._doDelete(id, this.undoStack);
  }

  correct(id, event) {
    this.redoStack = [];
    return this._doCorrect(id, event, this.undoStack);
  }

  undo() {
    const inv = this.undoStack.pop();
    if (!inv) return { op: 'undo', changed: false, removedSessions: [], addedSessions: [], shifts: [] };
    const diff = this._applyInverse(inv, this.redoStack);
    return { ...diff, op: 'undo', of: inv.type };
  }

  redo() {
    const inv = this.redoStack.pop();
    if (!inv) return { op: 'redo', changed: false, removedSessions: [], addedSessions: [], shifts: [] };
    const diff = this._applyInverse(inv, this.undoStack);
    return { ...diff, op: 'redo', of: inv.type };
  }

  _applyInverse(inv, recordTo) {
    if (inv.type === 'append') return this._doAppend(inv.event, recordTo);
    if (inv.type === 'delete') return this._doDelete(inv.id, recordTo);
    if (inv.type === 'correct') return this._doCorrect(inv.id, inv.event, recordTo);
    throw new DomainError('INTERNAL', `unknown inverse type ${inv.type}`);
  }

  // ---- snapshots -------------------------------------------------------------------

  sessionList() {
    return this.sessions.map(serializeSession);
  }

  shiftMetrics() {
    return this.shifts.map((s) => {
      const m = this.metrics.get(s.id);
      const span = s.endMs - s.startMs;
      return {
        id: s.id,
        start: toIso(s.startMs),
        end: toIso(s.endMs),
        runMs: m.runMs,
        failMs: m.failMs,
        availability: span > 0 ? round6(m.runMs / span) : null,
      };
    });
  }

  version() {
    const canon = {
      intervals: this.intervals.map((iv) => ({
        id: iv.id,
        start: toIso(iv.startMs),
        end: toIso(iv.endMs),
        state: iv.state,
      })),
      shifts: this.shifts.map((s) => ({ id: s.id, start: toIso(s.startMs), end: toIso(s.endMs) })),
    };
    return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
  }
}

function eventToJson(iv) {
  return { id: iv.id, start: toIso(iv.startMs), end: toIso(iv.endMs), state: iv.state };
}

module.exports = { Store };
