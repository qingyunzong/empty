import { windowCert, correctionCert } from "./cert.js";

export const WINDOW_MS = 300_000; // 5 minutes

// Streaming settlement engine.
//
// Semantics:
//  - watermark = max(ts seen so far) - wmLag; out-of-order events are accepted
//    while their ts >= watermark, otherwise recorded as LATE and not posted.
//  - A window closes (and is emitted with status "final") once
//    winEnd <= watermark; remaining windows are flushed by finish().
//  - A second auth/capture for an already-seen id is a CONFLICT and is
//    ignored (the first posting stands, never double-counted).
//  - A void retracts the posting with the same id. If the posting's window is
//    still open the posting is removed from it; if the window is already
//    closed a correction record (net = -amt) is emitted instead of rewriting
//    history. Voids of unknown or already-voided ids are CONFLICTs.
export class Engine {
  constructor(wmLag) {
    this.wmLag = wmLag;
    this.maxTs = null;
    this.watermark = null;
    this.windows = new Map(); // winStart -> Map(mch -> Map(id -> {id, kind, amt}))
    this.postings = new Map(); // id -> {id, winStart, mch, kind, amt, voided}
    this.out = [];
  }

  process(event, lineNo) {
    if (this.maxTs === null || event.ts > this.maxTs) this.maxTs = event.ts;
    this.watermark = this.maxTs - this.wmLag;
    this.#closeUpTo(this.watermark);

    if (event.type === "void") {
      this.#void(event, lineNo);
      return;
    }
    if (event.ts < this.watermark) {
      this.out.push({ code: "LATE", line: lineNo, id: event.id, ts: event.ts });
      return;
    }
    if (this.postings.has(event.id)) {
      this.out.push({ code: "CONFLICT", line: lineNo, id: event.id, reason: "duplicate-id" });
      return;
    }
    const winStart = Math.floor(event.ts / WINDOW_MS) * WINDOW_MS;
    const posting = { id: event.id, winStart, mch: event.mch, kind: event.type, amt: event.amt, voided: false };
    this.postings.set(event.id, posting);
    let byMch = this.windows.get(winStart);
    if (!byMch) {
      byMch = new Map();
      this.windows.set(winStart, byMch);
    }
    let byId = byMch.get(event.mch);
    if (!byId) {
      byId = new Map();
      byMch.set(event.mch, byId);
    }
    byId.set(event.id, posting);
  }

  #void(event, lineNo) {
    const posting = this.postings.get(event.id);
    if (!posting || posting.voided) {
      this.out.push({ code: "CONFLICT", line: lineNo, id: event.id, reason: "void-unknown-id" });
      return;
    }
    posting.voided = true;
    const byMch = this.windows.get(posting.winStart);
    if (byMch) {
      const byId = byMch.get(posting.mch);
      if (byId) byId.delete(posting.id);
      return;
    }
    // Window already closed: never rewrite history, emit a correction.
    this.out.push({
      winStart: posting.winStart,
      winEnd: posting.winStart + WINDOW_MS,
      mch: posting.mch,
      net: -posting.amt,
      cert: correctionCert(posting.winStart, posting.winStart + WINDOW_MS, posting.mch, posting.id, posting.amt),
      status: "correction",
    });
  }

  #closeUpTo(watermark) {
    const closable = [];
    for (const winStart of this.windows.keys()) {
      if (winStart + WINDOW_MS <= watermark) closable.push(winStart);
    }
    closable.sort((a, b) => a - b);
    for (const winStart of closable) this.#closeWindow(winStart);
  }

  #closeWindow(winStart) {
    const byMch = this.windows.get(winStart);
    this.windows.delete(winStart);
    if (!byMch) return;
    for (const mch of [...byMch.keys()].sort()) {
      const entries = [...byMch.get(mch).values()];
      if (entries.length === 0) continue;
      const net = entries.reduce((sum, e) => sum + e.amt, 0);
      this.out.push({
        winStart,
        winEnd: winStart + WINDOW_MS,
        mch,
        net,
        cert: windowCert(winStart, winStart + WINDOW_MS, mch, entries),
        status: "final",
      });
    }
  }

  finish() {
    this.#closeUpTo(Infinity);
    return this.out;
  }

  // Convenience: process all parsed events (line numbers are 1-based indexes)
  // and return every output record.
  settle(events) {
    events.forEach((event, i) => this.process(event, i + 1));
    return this.finish();
  }
}

export function settle(events, wmLag) {
  return new Engine(wmLag).settle(events);
}
