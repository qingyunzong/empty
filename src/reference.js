'use strict';

const {
  OeeError,
  normalizeInterval,
  compareIntervals,
  serializeSession,
  serializeShift,
} = require('./model');
const { DEFAULT_SHIFT_LENGTH_MS } = require('./engine');

function computeReference(rawIntervals, opts = {}) {
  const anchor = opts.shiftAnchor !== undefined ? opts.shiftAnchor : 0;
  const length = opts.shiftLength !== undefined ? opts.shiftLength : DEFAULT_SHIFT_LENGTH_MS;
  if (!Array.isArray(rawIntervals)) {
    throw new OeeError('INVALID_EVENTS', 'intervals must be an array');
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

  const sessions = [];
  const shifts = [];
  for (const device of [...byDevice.keys()].sort()) {
    const ivs = byDevice.get(device).slice().sort(compareIntervals);
    const seen = new Set();
    for (const iv of ivs) {
      if (seen.has(iv.id)) {
        throw new OeeError('DUPLICATE_ID', `duplicate interval id on device ${device}: ${iv.id}`);
      }
      seen.add(iv.id);
    }
    for (let i = 1; i < ivs.length; i++) {
      if (ivs[i - 1].end > ivs[i].start) {
        throw new OeeError('OVERLAP', `intervals overlap on device ${device}`, { device });
      }
    }

    const deviceSessions = [];
    let cur = null;
    for (const iv of ivs) {
      if (cur && cur.state === iv.state && cur.end === iv.start) {
        cur.end = iv.end;
        cur.sourceIds.push(iv.id);
      } else {
        if (cur) deviceSessions.push(cur);
        cur = { device, state: iv.state, start: iv.start, end: iv.end, sourceIds: [iv.id] };
      }
    }
    if (cur) deviceSessions.push(cur);
    for (const s of deviceSessions) sessions.push(serializeSession(s));

    const acc = new Map();
    for (const s of deviceSessions) {
      const k0 = Math.floor((s.start - anchor) / length);
      const k1 = Math.floor((s.end - 1 - anchor) / length);
      for (let k = k0; k <= k1; k++) {
        const ws = anchor + k * length;
        const we = ws + length;
        const ov = Math.min(s.end, we) - Math.max(s.start, ws);
        if (ov <= 0) continue;
        let m = acc.get(k);
        if (!m) {
          m = { runMs: 0, idleMs: 0, failMs: 0, maintMs: 0 };
          acc.set(k, m);
        }
        if (s.state === 'RUN') m.runMs += ov;
        else if (s.state === 'IDLE') m.idleMs += ov;
        else if (s.state === 'FAIL') m.failMs += ov;
        else m.maintMs += ov;
      }
    }
    for (const k of [...acc.keys()].sort((a, b) => a - b)) {
      const m = acc.get(k);
      const plannedMs = m.runMs + m.idleMs + m.failMs;
      if (plannedMs === 0 && m.maintMs === 0) continue;
      shifts.push(
        serializeShift(device, k, {
          ...m,
          plannedMs,
          availability: plannedMs > 0 ? m.runMs / plannedMs : null,
        }, anchor, length)
      );
    }
  }
  return { sessions, shifts };
}

module.exports = { computeReference };
