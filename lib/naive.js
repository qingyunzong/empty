import { windowCert, correctionCert } from "./cert.js";
import { WINDOW_MS } from "./engine.js";

// Naive full-replay implementation used as a differential oracle for the
// streaming engine (intended for inputs of at most ~200 events). It keeps the
// entire event log and recomputes window contents by scanning the whole log
// whenever a window closes, instead of maintaining incremental indexes.
export function naiveSettle(events, wmLag) {
  const out = [];
  const postings = []; // {id, winStart, mch, kind, amt, voided}
  const closed = new Set();
  let maxTs = null;

  const closeWindow = (winStart) => {
    closed.add(winStart);
    const byMch = new Map();
    for (const p of postings) {
      if (p.winStart !== winStart || p.voided) continue;
      if (!byMch.has(p.mch)) byMch.set(p.mch, []);
      byMch.get(p.mch).push(p);
    }
    for (const mch of [...byMch.keys()].sort()) {
      const entries = byMch.get(mch);
      const net = entries.reduce((sum, e) => sum + e.amt, 0);
      out.push({
        winStart,
        winEnd: winStart + WINDOW_MS,
        mch,
        net,
        cert: windowCert(winStart, winStart + WINDOW_MS, mch, entries),
        status: "final",
      });
    }
  };

  const closeUpTo = (watermark) => {
    const cand = new Set();
    for (const p of postings) {
      if (!closed.has(p.winStart) && p.winStart + WINDOW_MS <= watermark) cand.add(p.winStart);
    }
    for (const winStart of [...cand].sort((a, b) => a - b)) closeWindow(winStart);
  };

  events.forEach((event, i) => {
    const line = i + 1;
    maxTs = maxTs === null ? event.ts : Math.max(maxTs, event.ts);
    const watermark = maxTs - wmLag;
    closeUpTo(watermark);

    if (event.type === "void") {
      const posting = postings.find((p) => p.id === event.id && !p.voided);
      if (!posting) {
        out.push({ code: "CONFLICT", line, id: event.id, reason: "void-unknown-id" });
        return;
      }
      posting.voided = true;
      if (closed.has(posting.winStart)) {
        out.push({
          winStart: posting.winStart,
          winEnd: posting.winStart + WINDOW_MS,
          mch: posting.mch,
          net: -posting.amt,
          cert: correctionCert(posting.winStart, posting.winStart + WINDOW_MS, posting.mch, posting.id, posting.amt),
          status: "correction",
        });
      }
      return;
    }
    if (event.ts < watermark) {
      out.push({ code: "LATE", line, id: event.id, ts: event.ts });
      return;
    }
    if (postings.some((p) => p.id === event.id)) {
      out.push({ code: "CONFLICT", line, id: event.id, reason: "duplicate-id" });
      return;
    }
    postings.push({
      id: event.id,
      winStart: Math.floor(event.ts / WINDOW_MS) * WINDOW_MS,
      mch: event.mch,
      kind: event.type,
      amt: event.amt,
      voided: false,
    });
  });

  closeUpTo(Infinity);
  return out;
}

// Order-insensitive comparison of two record lists.
export function recordsEqual(a, b) {
  const canon = (records) =>
    records
      .map((r) => JSON.stringify(Object.keys(r).sort().reduce((o, k) => ((o[k] = r[k]), o), {})))
      .sort();
  const ca = canon(a);
  const cb = canon(b);
  return ca.length === cb.length && ca.every((r, i) => r === cb[i]);
}
