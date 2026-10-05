'use strict';

const {
  WINDOW_MS,
  windowOf,
  validateEvent,
  windowCert,
  correctionCert,
} = require('./common');

// Independent full-replay engine used by --naive to cross-check the streaming
// engine. Keeps the complete accepted-event history and recomputes every
// closing window by filtering/reducing the whole log from scratch.
// Intended for small inputs (<=200 events).
function naiveRun(parsed, allowedLatenessMs) {
  const records = [];
  let maxTs = -Infinity;
  let watermark = -Infinity;
  const closed = new Set();
  const seenIds = new Set();
  const voided = new Set();
  const accepted = []; // full history of accepted auth/capture entries
  const activeById = new Map();

  function emitWindow(ws) {
    const entries = accepted.filter(
      (e) => windowOf(e.ts) === ws && !voided.has(e.id)
    );
    const byMch = new Map();
    for (const e of entries) {
      if (!byMch.has(e.mch)) byMch.set(e.mch, []);
      byMch.get(e.mch).push(e);
    }
    const winEnd = ws + WINDOW_MS;
    for (const mch of [...byMch.keys()].sort()) {
      const list = byMch.get(mch);
      const net = list.reduce((sum, e) => sum + e.amt, 0);
      records.push({
        winStart: ws,
        winEnd,
        mch,
        net,
        cert: windowCert(ws, winEnd, mch, list),
        status: 'final',
      });
    }
  }

  function closeUpTo() {
    const starts = new Set();
    for (const e of accepted) starts.add(windowOf(e.ts));
    for (const s of [...starts].sort((a, b) => a - b)) {
      if (s + WINDOW_MS <= watermark && !closed.has(s)) {
        closed.add(s);
        emitWindow(s);
      }
    }
  }

  for (const { ev, lineNo } of parsed) {
    const err = validateEvent(ev);
    if (err) {
      records.push({ status: 'error', code: err, line: lineNo });
      continue;
    }
    if (ev.ts > maxTs) maxTs = ev.ts;
    watermark = maxTs - allowedLatenessMs;
    closeUpTo();

    if (ev.type === 'void') {
      const target = activeById.get(ev.id);
      if (!target) {
        records.push({ status: 'error', code: 'UNKNOWN_VOID', line: lineNo, id: ev.id });
        continue;
      }
      activeById.delete(ev.id);
      voided.add(ev.id);
      const ws = windowOf(target.ts);
      if (closed.has(ws)) {
        const winEnd = ws + WINDOW_MS;
        records.push({
          winStart: ws,
          winEnd,
          mch: target.mch,
          net: -target.amt,
          cert: correctionCert(ws, winEnd, target.mch, ev, target.amt),
          status: 'correction',
          voidOf: target.id,
          line: lineNo,
        });
      }
      continue;
    }

    if (ev.ts < watermark) {
      records.push({ status: 'late', line: lineNo, id: ev.id, ts: ev.ts, watermark });
      continue;
    }
    if (seenIds.has(ev.id)) {
      records.push({
        status: 'error',
        code: 'CONFLICT',
        line: lineNo,
        id: ev.id,
        reason: 'duplicate id',
      });
      continue;
    }
    seenIds.add(ev.id);
    const entry = { id: ev.id, type: ev.type, mch: ev.mch, amt: ev.amt, ts: ev.ts };
    accepted.push(entry);
    activeById.set(ev.id, entry);
  }

  // Flush everything still open, recomputed from the full log.
  const starts = new Set();
  for (const e of accepted) starts.add(windowOf(e.ts));
  for (const s of [...starts].sort((a, b) => a - b)) {
    if (!closed.has(s)) {
      closed.add(s);
      emitWindow(s);
    }
  }
  return records;
}

module.exports = { naiveRun };
