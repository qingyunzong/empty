'use strict';

const {
  WINDOW_MS,
  windowOf,
  validateEvent,
  windowCert,
  correctionCert,
} = require('./common');

// Streaming engine: keeps incremental per-window state, advances a watermark
// (maxTs - allowedLateness), closes windows whose end is <= watermark.
class Settler {
  constructor({ allowedLatenessMs }) {
    this.allowedLatenessMs = allowedLatenessMs;
    this.maxTs = -Infinity;
    this.watermark = -Infinity;
    this.windows = new Map(); // winStart -> Map<id, entry>
    this.activeById = new Map(); // id -> entry (not yet voided)
    this.seenIds = new Set(); // every auth/capture id ever accepted
    this.closedWindows = new Set();
    this.records = [];
  }

  process(ev, lineNo) {
    const err = validateEvent(ev);
    if (err) {
      this.records.push({ status: 'error', code: err, line: lineNo });
      return;
    }
    if (ev.ts > this.maxTs) this.maxTs = ev.ts;
    this.watermark = this.maxTs - this.allowedLatenessMs;
    this.closeWindowsUpTo(this.watermark);
    if (ev.type === 'void') this.handleVoid(ev, lineNo);
    else this.handleEntry(ev, lineNo);
  }

  handleEntry(ev, lineNo) {
    if (ev.ts < this.watermark) {
      this.records.push({
        status: 'late',
        line: lineNo,
        id: ev.id,
        ts: ev.ts,
        watermark: this.watermark,
      });
      return;
    }
    if (this.seenIds.has(ev.id)) {
      this.records.push({
        status: 'error',
        code: 'CONFLICT',
        line: lineNo,
        id: ev.id,
        reason: 'duplicate id',
      });
      return;
    }
    this.seenIds.add(ev.id);
    const entry = { id: ev.id, type: ev.type, mch: ev.mch, amt: ev.amt, ts: ev.ts };
    const ws = windowOf(ev.ts);
    if (!this.windows.has(ws)) this.windows.set(ws, new Map());
    this.windows.get(ws).set(ev.id, entry);
    this.activeById.set(ev.id, entry);
  }

  handleVoid(ev, lineNo) {
    const target = this.activeById.get(ev.id);
    if (!target) {
      this.records.push({ status: 'error', code: 'UNKNOWN_VOID', line: lineNo, id: ev.id });
      return;
    }
    this.activeById.delete(ev.id);
    const ws = windowOf(target.ts);
    if (this.closedWindows.has(ws)) {
      // Window already closed: never rewrite history, emit a correction instead.
      const winEnd = ws + WINDOW_MS;
      this.records.push({
        winStart: ws,
        winEnd,
        mch: target.mch,
        net: -target.amt,
        cert: correctionCert(ws, winEnd, target.mch, ev, target.amt),
        status: 'correction',
        voidOf: target.id,
        line: lineNo,
      });
      return;
    }
    const win = this.windows.get(ws);
    if (win) win.delete(ev.id);
  }

  closeWindowsUpTo(watermark) {
    const starts = [...this.windows.keys()]
      .filter((s) => s + WINDOW_MS <= watermark)
      .sort((a, b) => a - b);
    for (const s of starts) this.closeWindow(s);
  }

  closeWindow(ws) {
    const entries = this.windows.get(ws);
    this.windows.delete(ws);
    this.closedWindows.add(ws);
    if (!entries) return;
    const byMch = new Map();
    for (const e of entries.values()) {
      if (!byMch.has(e.mch)) byMch.set(e.mch, []);
      byMch.get(e.mch).push(e);
    }
    const winEnd = ws + WINDOW_MS;
    for (const mch of [...byMch.keys()].sort()) {
      const list = byMch.get(mch);
      const net = list.reduce((sum, e) => sum + e.amt, 0);
      this.records.push({
        winStart: ws,
        winEnd,
        mch,
        net,
        cert: windowCert(ws, winEnd, mch, list),
        status: 'final',
      });
    }
  }

  finish() {
    const starts = [...this.windows.keys()].sort((a, b) => a - b);
    for (const s of starts) this.closeWindow(s);
    return this.records;
  }
}

module.exports = { Settler };
