'use strict';

const { createHash } = require('crypto');
const {
  OeeError,
  normalizeInterval,
  compareIntervals,
  serializeInterval,
  serializeSession,
  serializeShift,
  canonical,
  parseTime,
} = require('./model');

const DEFAULT_SHIFT_LENGTH_MS = 8 * 3600 * 1000;

function lowerBound(arr, value, key) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sessionKey(s) {
  return `${s.device}|${s.state}|${s.start}|${s.end}`;
}

function netSessions(removed, added) {
  const counts = new Map();
  for (const s of removed) counts.set(sessionKey(s), (counts.get(sessionKey(s)) || 0) + 1);
  for (const s of added) counts.set(sessionKey(s), (counts.get(sessionKey(s)) || 0) - 1);
  const netRemoved = [];
  const netAdded = [];
  for (const s of removed) {
    const k = sessionKey(s);
    if (counts.get(k) > 0) {
      netRemoved.push(s);
      counts.set(k, counts.get(k) - 1);
    }
  }
  counts.clear();
  for (const s of added) counts.set(sessionKey(s), (counts.get(sessionKey(s)) || 0) + 1);
  for (const s of removed) counts.set(sessionKey(s), (counts.get(sessionKey(s)) || 0) - 1);
  for (const s of added) {
    const k = sessionKey(s);
    if (counts.get(k) > 0) {
      netAdded.push(s);
      counts.set(k, counts.get(k) - 1);
    }
  }
  return { netRemoved, netAdded };
}

class Engine {
  constructor(opts = {}) {
    this.shiftAnchor = opts.shiftAnchor !== undefined ? opts.shiftAnchor : 0;
    this.shiftLength = opts.shiftLength !== undefined ? opts.shiftLength : DEFAULT_SHIFT_LENGTH_MS;
    this.devices = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.autoCounter = 0;
  }

  _deviceState(id) {
    let ds = this.devices.get(id);
    if (!ds) {
      ds = { intervals: [], sessions: [], shifts: new Map() };
      this.devices.set(id, ds);
    }
    return ds;
  }

  _findById(id) {
    for (const [device, ds] of this.devices) {
      const iv = ds.intervals.find((x) => x.id === id);
      if (iv) return { device, interval: iv };
    }
    return null;
  }

  loadEvents(events) {
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      throw new OeeError('INVALID_EVENTS', 'events file must contain a JSON object');
    }
    if (events.shift !== undefined) {
      const shift = events.shift;
      if (!shift || typeof shift !== 'object') {
        throw new OeeError('INVALID_EVENTS', 'events.shift must be an object');
      }
      if (shift.anchor !== undefined) this.shiftAnchor = parseTime(shift.anchor, 'shift.anchor');
      if (shift.lengthHours !== undefined) {
        if (!(typeof shift.lengthHours === 'number' && shift.lengthHours > 0)) {
          throw new OeeError('INVALID_EVENTS', 'events.shift.lengthHours must be a positive number');
        }
        this.shiftLength = shift.lengthHours * 3600 * 1000;
      }
      if (shift.lengthMs !== undefined) {
        if (!(typeof shift.lengthMs === 'number' && shift.lengthMs > 0)) {
          throw new OeeError('INVALID_EVENTS', 'events.shift.lengthMs must be a positive number');
        }
        this.shiftLength = Math.trunc(shift.lengthMs);
      }
    }
    const rawIntervals = events.intervals === undefined ? [] : events.intervals;
    if (!Array.isArray(rawIntervals)) {
      throw new OeeError('INVALID_EVENTS', 'events.intervals must be an array');
    }
    const byDevice = new Map();
    rawIntervals.forEach((raw, i) => {
      const iv = normalizeInterval(raw, `evt-${i}`);
      let list = byDevice.get(iv.device);
      if (!list) {
        list = [];
        byDevice.set(iv.device, list);
      }
      list.push(iv);
    });
    const changes = [...byDevice.entries()].map(([device, adds]) => ({
      device,
      adds,
      removeIds: [],
    }));
    this._applyChanges(changes);
  }

  executeCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
      throw new OeeError('INVALID_COMMAND', 'command must be an object', { command: cmd });
    }
    switch (cmd.op) {
      case 'append': {
        const iv = normalizeInterval(cmd.interval, `auto-${this.autoCounter++}`);
        return this._commit([{ device: iv.device, adds: [iv], removeIds: [] }]);
      }
      case 'correct': {
        if (typeof cmd.id !== 'string') {
          throw new OeeError('INVALID_COMMAND', 'correct requires an id', { command: cmd });
        }
        const found = this._findById(cmd.id);
        if (!found) {
          throw new OeeError('NOT_FOUND', `interval not found: ${cmd.id}`, { id: cmd.id });
        }
        const patch = cmd.interval === undefined ? {} : cmd.interval;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new OeeError('INVALID_COMMAND', 'correct.interval must be an object', { command: cmd });
        }
        const merged = Object.assign({}, found.interval, patch, { id: found.interval.id });
        const iv = normalizeInterval(merged);
        if (iv.device === found.device) {
          return this._commit([{ device: found.device, adds: [iv], removeIds: [iv.id] }]);
        }
        return this._commit([
          { device: found.device, adds: [], removeIds: [found.interval.id] },
          { device: iv.device, adds: [iv], removeIds: [] },
        ]);
      }
      case 'delete': {
        if (typeof cmd.id !== 'string') {
          throw new OeeError('INVALID_COMMAND', 'delete requires an id', { command: cmd });
        }
        const found = this._findById(cmd.id);
        if (!found) {
          throw new OeeError('NOT_FOUND', `interval not found: ${cmd.id}`, { id: cmd.id });
        }
        return this._commit([{ device: found.device, adds: [], removeIds: [cmd.id] }]);
      }
      case 'undo':
        return this._undo();
      case 'redo':
        return this._redo();
      default:
        throw new OeeError('UNKNOWN_OP', `unknown op: ${JSON.stringify(cmd.op)}`, { op: cmd.op });
    }
  }

  _commit(changes) {
    const { diff, inverse } = this._applyChanges(changes);
    this.undoStack.push(inverse);
    this.redoStack = [];
    return diff;
  }

  _undo() {
    const inverse = this.undoStack.pop();
    if (!inverse) throw new OeeError('NOTHING_TO_UNDO', 'nothing to undo');
    const { diff, inverse: redoInverse } = this._applyChanges(inverse);
    this.redoStack.push(redoInverse);
    return diff;
  }

  _redo() {
    const inverse = this.redoStack.pop();
    if (!inverse) throw new OeeError('NOTHING_TO_REDO', 'nothing to redo');
    const { diff, inverse: undoInverse } = this._applyChanges(inverse);
    this.undoStack.push(undoInverse);
    return diff;
  }

  _applyChanges(changes) {
    const diff = { sessionsAdded: [], sessionsRemoved: [], shifts: [] };
    const inverse = [];
    for (const change of changes) {
      const res = this._applyDeviceChange(change.device, change.adds, change.removeIds);
      diff.sessionsAdded.push(...res.diff.sessionsAdded);
      diff.sessionsRemoved.push(...res.diff.sessionsRemoved);
      diff.shifts.push(...res.diff.shifts);
      inverse.push({
        device: change.device,
        adds: res.removedIntervals,
        removeIds: change.adds.map((iv) => iv.id),
      });
    }
    return { diff, inverse };
  }

  _applyDeviceChange(deviceId, adds, removeIds) {
    const ds = this._deviceState(deviceId);

    const removeSet = new Set(removeIds);
    if (removeSet.size !== removeIds.length) {
      throw new OeeError('INVALID_COMMAND', `duplicate remove ids for device ${deviceId}`, {
        device: deviceId,
        removeIds,
      });
    }
    const removed = [];
    const remaining = [];
    for (const iv of ds.intervals) {
      if (removeSet.has(iv.id)) removed.push(iv);
      else remaining.push(iv);
    }
    if (removed.length !== removeSet.size) {
      const have = new Set(removed.map((iv) => iv.id));
      const missing = [...removeSet].filter((id) => !have.has(id));
      throw new OeeError('NOT_FOUND', `interval not found on device ${deviceId}: ${missing.join(', ')}`, {
        device: deviceId,
        ids: missing,
      });
    }

    const ids = new Set(remaining.map((iv) => iv.id));
    for (const iv of adds) {
      if (ids.has(iv.id)) {
        throw new OeeError('DUPLICATE_ID', `duplicate interval id on device ${deviceId}: ${iv.id}`, {
          device: deviceId,
          id: iv.id,
        });
      }
      ids.add(iv.id);
    }

    const merged = remaining.concat(adds).sort(compareIntervals);
    for (let i = 1; i < merged.length; i++) {
      if (merged[i - 1].end > merged[i].start) {
        throw new OeeError(
          'OVERLAP',
          `intervals overlap on device ${deviceId}: ` +
            `[${merged[i - 1].start}, ${merged[i - 1].end}) vs [${merged[i].start}, ${merged[i].end})`,
          {
            device: deviceId,
            a: serializeInterval(merged[i - 1]),
            b: serializeInterval(merged[i]),
          }
        );
      }
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const iv of removed) {
      if (iv.start < lo) lo = iv.start;
      if (iv.end > hi) hi = iv.end;
    }
    for (const iv of adds) {
      if (iv.start < lo) lo = iv.start;
      if (iv.end > hi) hi = iv.end;
    }

    ds.intervals = merged;

    const { removedSessions, addedSessions, rangeLo, rangeHi } = this._rebuildSessions(ds, lo, hi);
    const diff = { sessionsAdded: [], sessionsRemoved: [], shifts: [] };
    const net = netSessions(removedSessions, addedSessions);
    diff.sessionsRemoved = net.netRemoved.map(serializeSession);
    diff.sessionsAdded = net.netAdded.map(serializeSession);
    this._recomputeShifts(ds, deviceId, removedSessions, addedSessions, rangeLo, rangeHi, diff);
    return { diff, removedIntervals: removed };
  }

  _rebuildSessions(ds, lo, hi) {
    const ivs = ds.intervals;
    let startIdx = lowerBound(ivs, lo, (iv) => iv.end);
    let endIdx = -1;
    if (startIdx < ivs.length) {
      endIdx = lowerBound(ivs, hi + 1, (iv) => iv.start) - 1;
      if (endIdx < startIdx) {
        startIdx = -1;
        endIdx = -1;
      }
    } else {
      startIdx = -1;
    }

    let rangeLo = lo;
    let rangeHi = hi;
    const addedSessions = [];
    if (startIdx >= 0) {
      while (
        startIdx > 0 &&
        ivs[startIdx - 1].end === ivs[startIdx].start &&
        ivs[startIdx - 1].state === ivs[startIdx].state
      ) {
        startIdx--;
      }
      while (
        endIdx < ivs.length - 1 &&
        ivs[endIdx + 1].start === ivs[endIdx].end &&
        ivs[endIdx + 1].state === ivs[endIdx].state
      ) {
        endIdx++;
      }
      rangeLo = ivs[startIdx].start;
      rangeHi = ivs[endIdx].end;
      let cur = null;
      for (let i = startIdx; i <= endIdx; i++) {
        const iv = ivs[i];
        if (cur && cur.state === iv.state && cur.end === iv.start) {
          cur.end = iv.end;
          cur.sourceIds.push(iv.id);
        } else {
          if (cur) addedSessions.push(cur);
          cur = { device: iv.device, state: iv.state, start: iv.start, end: iv.end, sourceIds: [iv.id] };
        }
      }
      if (cur) addedSessions.push(cur);
    }

    const sessions = ds.sessions;
    const removeLo = Math.min(lo, rangeLo);
    const removeHi = Math.max(hi, rangeHi);
    const from = lowerBound(sessions, removeLo + 1, (s) => s.end);
    const to = lowerBound(sessions, removeHi, (s) => s.start);
    const removedSessions = sessions.slice(from, to);
    sessions.splice(from, to - from, ...addedSessions);
    return { removedSessions, addedSessions, rangeLo, rangeHi };
  }

  _recomputeShifts(ds, deviceId, removedSessions, addedSessions, rangeLo, rangeHi, diff) {
    let loT = Infinity;
    let hiT = -Infinity;
    for (const s of removedSessions) {
      if (s.start < loT) loT = s.start;
      if (s.end > hiT) hiT = s.end;
    }
    for (const s of addedSessions) {
      if (s.start < loT) loT = s.start;
      if (s.end > hiT) hiT = s.end;
    }
    if (!(loT < hiT)) {
      loT = rangeLo;
      hiT = rangeHi;
    }
    if (!(loT < hiT)) return;

    const k0 = Math.floor((loT - this.shiftAnchor) / this.shiftLength);
    const k1 = Math.floor((hiT - 1 - this.shiftAnchor) / this.shiftLength);
    for (let k = k0; k <= k1; k++) {
      const ws = this.shiftAnchor + k * this.shiftLength;
      const we = ws + this.shiftLength;
      const m = { runMs: 0, idleMs: 0, failMs: 0, maintMs: 0 };
      for (const sess of ds.sessions) {
        if (sess.end <= ws) continue;
        if (sess.start >= we) break;
        const ov = Math.min(sess.end, we) - Math.max(sess.start, ws);
        if (ov <= 0) continue;
        if (sess.state === 'RUN') m.runMs += ov;
        else if (sess.state === 'IDLE') m.idleMs += ov;
        else if (sess.state === 'FAIL') m.failMs += ov;
        else m.maintMs += ov;
      }
      const plannedMs = m.runMs + m.idleMs + m.failMs;
      const before = ds.shifts.has(k) ? ds.shifts.get(k) : null;
      if (plannedMs === 0 && m.maintMs === 0) {
        ds.shifts.delete(k);
      } else {
        ds.shifts.set(k, {
          ...m,
          plannedMs,
          availability: plannedMs > 0 ? m.runMs / plannedMs : null,
        });
      }
      const after = ds.shifts.has(k) ? ds.shifts.get(k) : null;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        diff.shifts.push({ device: deviceId, shiftIndex: k, before, after });
      }
    }
  }

  snapshot() {
    const intervals = [];
    const sessions = [];
    const shifts = [];
    for (const device of [...this.devices.keys()].sort()) {
      const ds = this.devices.get(device);
      for (const iv of ds.intervals) intervals.push(serializeInterval(iv));
      for (const s of ds.sessions) sessions.push(serializeSession(s));
      for (const k of [...ds.shifts.keys()].sort((a, b) => a - b)) {
        shifts.push(serializeShift(device, k, ds.shifts.get(k), this.shiftAnchor, this.shiftLength));
      }
    }
    const version = createHash('sha256')
      .update(canonical({ intervals, sessions, shifts }))
      .digest('hex');
    return { intervals, sessions, shifts, version };
  }
}

module.exports = { Engine, DEFAULT_SHIFT_LENGTH_MS };
