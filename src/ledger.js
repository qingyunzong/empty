'use strict';

const { createHash } = require('node:crypto');

const DOMAIN = 'ELC1';
const ZERO_HASH = '0'.repeat(64);
const NAIVE_MAX_EVENTS = 150;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hash(domain, payload) {
  return createHash('sha256')
    .update(`${DOMAIN}:${domain}:`, 'utf8')
    .update(payload, 'utf8')
    .digest('hex');
}

function eventPayload(rec) {
  return {
    seq: rec.seq,
    eventTime: rec.eventTime,
    type: rec.type,
    acct: rec.acct,
    amount: rec.amount,
    ref: rec.ref,
    window: rec.window,
    applied: rec.applied,
    error: rec.error,
  };
}

function addTotal(totals, acct, delta) {
  totals[acct] = (totals[acct] || 0) + delta;
}

function normalizeEvent(ev) {
  return {
    seq: ev.seq,
    eventTime: ev.eventTime,
    type: ev.type,
    acct: ev.acct ?? null,
    amount: ev.amount ?? 0,
    ref: ev.ref ?? null,
  };
}

function buildReport(inputEvents, opts = {}) {
  const windowSize = opts.windowSize ?? 3600;
  const lateness = opts.lateness ?? 0;
  if (!Number.isFinite(windowSize) || windowSize <= 0) throw new Error('windowSize must be a positive number');
  if (!Number.isFinite(lateness) || lateness < 0) throw new Error('lateness must be a non-negative number');

  const events = [...inputEvents].map(normalizeEvent).sort((a, b) => a.seq - b.seq);
  const allSeqs = new Set(events.map((e) => e.seq));

  const windows = new Map();
  const appendix = [];
  const errors = [];
  const seqIndex = new Map(); // seq -> base seq of its version chain
  const chains = new Map(); // base seq -> ordered version records
  let maxEventTime = null;

  const getWindow = (id) => {
    let win = windows.get(id);
    if (!win) {
      win = {
        id,
        start: id * windowSize,
        end: (id + 1) * windowSize,
        sealed: false,
        totals: {},
        events: [],
      };
      windows.set(id, win);
    }
    return win;
  };

  for (const rec of events) {
    if (maxEventTime === null || rec.eventTime > maxEventTime) maxEventTime = rec.eventTime;
    const watermark = maxEventTime - lateness;
    const windowId = Math.floor(rec.eventTime / windowSize);
    rec.window = windowId;
    rec.applied = false;
    rec.error = null;
    const win = getWindow(windowId);

    if (win.end <= watermark) {
      appendix.push({ event: rec, reason: 'SEALED_WINDOW' });
      continue;
    }
    win.events.push(rec);

    if (rec.type === 'append') {
      if (seqIndex.has(rec.seq)) {
        rec.error = 'DUP_SEQ';
        errors.push({ seq: rec.seq, code: 'DUP_SEQ' });
      } else {
        seqIndex.set(rec.seq, rec.seq);
        chains.set(rec.seq, [rec]);
        rec.applied = true;
        addTotal(win.totals, rec.acct, rec.amount);
      }
    } else if (rec.type === 'correct') {
      if (typeof rec.ref !== 'number') {
        rec.error = 'DANGLING';
        errors.push({ seq: rec.seq, code: 'DANGLING', ref: rec.ref });
      } else if (rec.ref >= rec.seq && allSeqs.has(rec.ref)) {
        rec.error = 'FUTURE_REF';
        errors.push({ seq: rec.seq, code: 'FUTURE_REF', ref: rec.ref });
      } else if (!seqIndex.has(rec.ref)) {
        rec.error = 'DANGLING';
        errors.push({ seq: rec.seq, code: 'DANGLING', ref: rec.ref });
      } else {
        const base = seqIndex.get(rec.ref);
        const chain = chains.get(base);
        const prev = chain[chain.length - 1];
        seqIndex.set(rec.seq, base);
        chain.push(rec);
        rec.applied = true;
        addTotal(win.totals, rec.acct, rec.amount - prev.amount);
      }
    } else {
      rec.error = 'BAD_TYPE';
      errors.push({ seq: rec.seq, code: 'BAD_TYPE' });
    }
  }

  const sortedWindows = [...windows.values()].sort((a, b) => a.id - b.id);
  let prevHash = ZERO_HASH;
  for (const win of sortedWindows) {
    win.sealed = true;
    win.prev = prevHash;
    win.headerHash = hash('header', canonical({ id: win.id, start: win.start, end: win.end, prev: win.prev }));
    for (const rec of win.events) rec.hash = hash('event', canonical(eventPayload(rec)));
    win.hash = hash('window', canonical({
      header: win.headerHash,
      events: win.events.map((e) => e.hash),
      totals: win.totals,
    }));
    prevHash = win.hash;
  }

  for (const entry of appendix) {
    entry.event.hash = hash('event', canonical(eventPayload(entry.event)));
    entry.hash = hash('appendix', canonical({
      event: entry.event.hash,
      reason: entry.reason,
      window: entry.event.window,
    }));
  }
  const appendixHash = hash('appendix-list', canonical(appendix.map((a) => a.hash)));

  const root = hash('root', canonical({
    version: 1,
    params: { windowSize, lateness },
    windows: sortedWindows.map((w) => w.hash),
    appendix: appendixHash,
    errors,
  }));

  if (opts.naive) {
    if (events.length > NAIVE_MAX_EVENTS) {
      throw new Error(`--naive supports at most ${NAIVE_MAX_EVENTS} events, got ${events.length}`);
    }
    const check = naiveReplay(events, windowSize, lateness);
    for (const win of sortedWindows) {
      const naiveTotals = check.totals.get(win.id) || {};
      if (canonical(win.totals) !== canonical(naiveTotals)) {
        throw new Error(`naive cross-check failed for window ${win.id}`);
      }
    }
    for (const [id] of check.totals) {
      if (!windows.has(id)) throw new Error(`naive cross-check produced unknown window ${id}`);
    }
    if (check.appendixCount !== appendix.length) {
      throw new Error(`naive cross-check failed for appendix: ${check.appendixCount} != ${appendix.length}`);
    }
  }

  return {
    version: 1,
    params: { windowSize, lateness },
    windows: sortedWindows,
    appendix,
    errors,
    root,
  };
}

// Independent full replay: rebuild every version chain from scratch and derive
// window totals by walking each chain version by version.
function naiveReplay(inputEvents, windowSize, lateness) {
  const events = [...inputEvents].sort((a, b) => a.seq - b.seq);
  const chains = new Map();
  const seqIndex = new Map();
  let maxEventTime = null;
  let appendixCount = 0;

  for (const ev of events) {
    if (maxEventTime === null || ev.eventTime > maxEventTime) maxEventTime = ev.eventTime;
    const watermark = maxEventTime - lateness;
    const windowId = Math.floor(ev.eventTime / windowSize);
    if ((windowId + 1) * windowSize <= watermark) {
      appendixCount += 1;
      continue;
    }
    if (ev.type === 'append' && !seqIndex.has(ev.seq)) {
      seqIndex.set(ev.seq, ev.seq);
      chains.set(ev.seq, [ev]);
    } else if (
      ev.type === 'correct' &&
      typeof ev.ref === 'number' &&
      ev.ref < ev.seq &&
      seqIndex.has(ev.ref)
    ) {
      const base = seqIndex.get(ev.ref);
      chains.get(base).push(ev);
      seqIndex.set(ev.seq, base);
    }
  }

  const totals = new Map();
  for (const chain of chains.values()) {
    for (let i = 0; i < chain.length; i += 1) {
      const cur = chain[i];
      const prevAmount = i === 0 ? 0 : chain[i - 1].amount;
      const windowId = Math.floor(cur.eventTime / windowSize);
      if (!totals.has(windowId)) totals.set(windowId, {});
      addTotal(totals.get(windowId), cur.acct, cur.amount - prevAmount);
    }
  }
  return { totals, appendixCount };
}

function verifyReport(report) {
  const failures = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, failures: [{ where: 'report', detail: 'report is not an object' }] };
  }
  const params = report.params || {};
  const reportWindows = Array.isArray(report.windows) ? report.windows : [];
  const reportAppendix = Array.isArray(report.appendix) ? report.appendix : [];

  const events = [];
  for (const win of reportWindows) {
    for (const ev of win.events || []) events.push(ev);
  }
  for (const entry of reportAppendix) {
    if (entry && entry.event) events.push(entry.event);
  }

  let rebuilt;
  try {
    rebuilt = buildReport(events, { windowSize: params.windowSize, lateness: params.lateness });
  } catch (err) {
    return { ok: false, failures: [{ where: 'report', detail: `rebuild failed: ${err.message}` }] };
  }

  const rebuiltById = new Map(rebuilt.windows.map((w) => [w.id, w]));
  const reportIds = new Set();
  for (const win of reportWindows) {
    reportIds.add(win.id);
    const expected = rebuiltById.get(win.id);
    if (!expected) {
      failures.push({ where: `window ${win.id}`, detail: 'unexpected window not derivable from events' });
    } else if (canonical(win) !== canonical(expected)) {
      failures.push({ where: `window ${win.id}`, detail: 'window content does not match recomputation' });
    }
  }
  for (const win of rebuilt.windows) {
    if (!reportIds.has(win.id)) {
      failures.push({ where: `window ${win.id}`, detail: 'window missing from report' });
    }
  }

  if (canonical(reportAppendix) !== canonical(rebuilt.appendix)) {
    failures.push({ where: 'appendix', detail: 'appendix does not match recomputation' });
  }
  if (canonical(report.errors || []) !== canonical(rebuilt.errors)) {
    failures.push({ where: 'errors', detail: 'error list does not match recomputation' });
  }
  if (report.root !== rebuilt.root) {
    failures.push({ where: 'root', detail: `root mismatch: report=${report.root} recomputed=${rebuilt.root}` });
  }
  return { ok: failures.length === 0, failures };
}

module.exports = {
  buildReport,
  verifyReport,
  naiveReplay,
  canonical,
  hash,
  NAIVE_MAX_EVENTS,
};
