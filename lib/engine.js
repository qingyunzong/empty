'use strict';
const { canon } = require('./util');
const { leafHash, merkleRoot } = require('./merkle');

const EXIT = { FRAME: 2, DUP_CONFLICT: 3, SEQ_GAP: 4, CYCLE: 5 };

class LedgerError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'LedgerError';
    this.exitCode = exitCode;
  }
}

function badFrame(msg) {
  throw new LedgerError(EXIT.FRAME, msg);
}

function validateEvent(ev) {
  if (typeof ev.eventId !== 'string' || !ev.eventId) badFrame('eventId must be a non-empty string');
  if (typeof ev.acct !== 'string' || !ev.acct) badFrame(`event ${ev.eventId}: acct must be a non-empty string`);
  if (!Number.isSafeInteger(ev.amount)) badFrame(`event ${ev.eventId}: amount must be an integer (cents)`);
  if (!Number.isSafeInteger(ev.branchSeq) || ev.branchSeq < 1) badFrame(`event ${ev.eventId}: branchSeq must be an integer >= 1`);
  if (!Number.isSafeInteger(ev.logicalTs) || ev.logicalTs < 0) badFrame(`event ${ev.eventId}: logicalTs must be an integer >= 0`);
  if (ev.replaces !== undefined && ev.replaces !== null && (typeof ev.replaces !== 'string' || !ev.replaces)) {
    badFrame(`event ${ev.eventId}: replaces must be an eventId string`);
  }
  if (ev.causes !== undefined && (!Array.isArray(ev.causes) || ev.causes.some((c) => typeof c !== 'string'))) {
    badFrame(`event ${ev.eventId}: causes must be an array of eventId strings`);
  }
}

// Deterministic causal linearization: same-acct edges follow branchSeq,
// explicit `causes` edges add cross-acct happens-before, ties break by
// (logicalTs, eventId). Cycles are rejected.
function topoOrder(events) {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const indeg = new Map(events.map((e) => [e.eventId, 0]));
  const adj = new Map(events.map((e) => [e.eventId, []]));
  const edge = (a, b) => {
    adj.get(a).push(b);
    indeg.set(b, indeg.get(b) + 1);
  };
  const perAcct = new Map();
  for (const e of events) {
    if (!perAcct.has(e.acct)) perAcct.set(e.acct, []);
    perAcct.get(e.acct).push(e);
  }
  for (const list of perAcct.values()) {
    list.sort((x, y) => x.branchSeq - y.branchSeq);
    for (let i = 1; i < list.length; i++) edge(list[i - 1].eventId, list[i].eventId);
  }
  for (const e of events) {
    for (const c of e.causes || []) {
      if (c === e.eventId) throw new LedgerError(EXIT.CYCLE, `event ${e.eventId} causes itself`);
      if (byId.has(c)) edge(c, e.eventId);
    }
  }
  const ready = events.filter((e) => indeg.get(e.eventId) === 0);
  const out = [];
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i];
      const b = ready[best];
      if (a.logicalTs < b.logicalTs || (a.logicalTs === b.logicalTs && a.eventId < b.eventId)) best = i;
    }
    const cur = ready.splice(best, 1)[0];
    out.push(cur);
    for (const n of adj.get(cur.eventId)) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) ready.push(byId.get(n));
    }
  }
  if (out.length !== events.length) {
    throw new LedgerError(EXIT.CYCLE, 'cyclic causality detected among period events');
  }
  return out;
}

class Engine {
  constructor({ window = 8 } = {}) {
    this.window = window;
    this.seenPayloads = new Map(); // eventId -> canonical payload (dedup / conflict)
    this.accts = new Map(); // acct -> {next, buffered:Map, seqs:Set}
    this.unsettled = []; // accepted events not yet settled into a period
    this.periods = [];
    this.entries = []; // global immutable append-only log
    this.byEventId = new Map(); // eventId -> latest posted {acct, amount}
    this.replacedTargets = new Set();
    this.balances = new Map();
    this.closeHistory = []; // cutoffs of prior closes (late detection)
    this.closedPeriodIds = new Map(); // periodId -> cutoff (close dedup)
    this.pendingSnapshot = [];
  }

  accept(rawObj) {
    const obj = { ...rawObj };
    delete obj.checksum;
    const type = obj.type || 'event';
    if (type === 'close') return this.close(obj);
    if (type !== 'event') badFrame(`unknown frame type: ${JSON.stringify(type)}`);
    return this.addEvent(obj);
  }

  acctState(acct) {
    if (!this.accts.has(acct)) this.accts.set(acct, { next: 1, buffered: new Map(), seqs: new Set() });
    return this.accts.get(acct);
  }

  addEvent(ev) {
    validateEvent(ev);
    const fp = canon(ev);
    const prev = this.seenPayloads.get(ev.eventId);
    if (prev !== undefined) {
      if (prev === fp) return { dedup: true };
      throw new LedgerError(EXIT.DUP_CONFLICT, `eventId ${ev.eventId} re-sent with different payload`);
    }
    const st = this.acctState(ev.acct);
    if (st.seqs.has(ev.branchSeq)) {
      throw new LedgerError(EXIT.SEQ_GAP, `acct ${ev.acct}: branchSeq ${ev.branchSeq} reused by ${ev.eventId}`);
    }
    this.seenPayloads.set(ev.eventId, fp);
    st.seqs.add(ev.branchSeq);
    if (ev.branchSeq !== st.next) {
      if (ev.branchSeq - st.next > this.window) {
        throw new LedgerError(EXIT.SEQ_GAP,
          `acct ${ev.acct}: missing branchSeq ${st.next}..${ev.branchSeq - 1} beyond window ${this.window}`);
      }
      st.buffered.set(ev.branchSeq, ev);
      return { buffered: true };
    }
    this.unsettled.push(ev);
    st.next++;
    while (st.buffered.has(st.next)) {
      this.unsettled.push(st.buffered.get(st.next));
      st.buffered.delete(st.next);
      st.next++;
    }
    return { accepted: true };
  }

  close(obj) {
    const { periodId, cutoff } = obj;
    if (typeof periodId !== 'string' || !periodId) badFrame('close frame requires a periodId string');
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) badFrame(`close ${periodId}: cutoff must be an integer >= 0`);
    const prevCut = this.closedPeriodIds.get(periodId);
    if (prevCut !== undefined) {
      if (prevCut === cutoff) return { dedup: true };
      throw new LedgerError(EXIT.DUP_CONFLICT, `period ${periodId} re-closed with different cutoff`);
    }
    this.closedPeriodIds.set(periodId, cutoff);
    this.settlePeriod(periodId, cutoff, false);
    return { closed: periodId };
  }

  settlePeriod(periodId, cutoff, auto) {
    const cutoffVal = cutoff === null ? Number.MAX_SAFE_INTEGER : cutoff;
    const settle = [];
    const remain = [];
    for (const ev of this.unsettled) (ev.logicalTs <= cutoffVal ? settle : remain).push(ev);
    if (auto && settle.length === 0) return null;
    // Causal dependency fixpoint: a correction (replaces) or caused event
    // cannot settle before the event it depends on; defer it to a later
    // period instead of settling an inconsistent history.
    const inRemain = new Set(remain.map((e) => e.eventId));
    const inSettle = new Map(settle.map((e) => [e.eventId, e]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, ev] of [...inSettle]) {
        const deps = [];
        if (ev.replaces) deps.push(ev.replaces);
        for (const c of ev.causes || []) deps.push(c);
        if (deps.some((d) => !this.byEventId.has(d) && inRemain.has(d))) {
          inSettle.delete(id);
          inRemain.add(id);
          remain.push(ev);
          changed = true;
        }
      }
    }
    const ordered = topoOrder([...inSettle.values()]);
    this.unsettled = remain;
    const balancesBefore = Object.fromEntries(this.balances);
    const entries = [];
    for (const ev of ordered) {
      const late = this.closeHistory.some((c) => c >= ev.logicalTs);
      entries.push(...this.materialize(ev, periodId, late));
    }
    for (const e of entries) {
      e.seq = this.entries.length + 1;
      this.entries.push(e);
    }
    const balancesAfter = Object.fromEntries(this.balances);
    const leaves = entries.map(leafHash);
    const period = { periodId, cutoff, entries, balancesBefore, balancesAfter, leaves, root: merkleRoot(leaves) };
    this.periods.push(period);
    this.closeHistory.push(cutoffVal);
    return period;
  }

  // Corrections never mutate posted entries: append reversal + replacement
  // linked to the original eventId.
  materialize(ev, periodId, late) {
    const base = { periodId, acct: ev.acct, logicalTs: ev.logicalTs, branchSeq: ev.branchSeq, late };
    const out = [];
    if (ev.replaces) {
      const orig = this.byEventId.get(ev.replaces);
      if (!orig) throw new LedgerError(EXIT.FRAME, `event ${ev.eventId} replaces unknown event ${ev.replaces}`);
      if (orig.acct !== ev.acct) throw new LedgerError(EXIT.FRAME, `correction ${ev.eventId} must stay on acct ${orig.acct}`);
      if (this.replacedTargets.has(ev.replaces)) throw new LedgerError(EXIT.FRAME, `event ${ev.replaces} already corrected`);
      this.replacedTargets.add(ev.replaces);
      out.push({ ...base, kind: 'reversal', id: `${ev.eventId}:rev`, of: ev.replaces, by: ev.eventId, acct: orig.acct, amount: -orig.amount });
      out.push({ ...base, kind: 'replacement', id: ev.eventId, of: ev.replaces, acct: ev.acct, amount: ev.amount });
    } else {
      out.push({ ...base, kind: 'post', id: ev.eventId, amount: ev.amount });
    }
    for (const e of out) {
      this.balances.set(e.acct, (this.balances.get(e.acct) || 0) + e.amount);
    }
    this.byEventId.set(ev.eventId, { acct: ev.acct, amount: ev.amount });
    return out;
  }

  finalize() {
    if (this.closeHistory.length > 0 && this.unsettled.length > 0) {
      this.pendingSnapshot = this.unsettled.map((ev) => ({
        eventId: ev.eventId, acct: ev.acct, logicalTs: ev.logicalTs, reason: 'deferred past period close',
      }));
    }
    if (this.unsettled.length > 0) {
      const period = this.settlePeriod(`P${this.periods.length + 1}`, null, true);
      for (const p of this.pendingSnapshot) p.settledIn = period.periodId;
    }
    const gaps = [];
    for (const [acct, st] of this.accts) {
      if (st.buffered.size > 0) gaps.push(`${acct}: missing branchSeq ${st.next}`);
    }
    if (gaps.length) {
      throw new LedgerError(EXIT.SEQ_GAP, `unfilled sequence gap at end of input: ${gaps.join('; ')}`);
    }
  }

  balancesObj() {
    return Object.fromEntries([...this.balances].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  certFor(period, certPath) {
    return {
      version: 1,
      periodId: period.periodId,
      cutoff: period.cutoff,
      initialBalances: period.balancesBefore,
      balances: period.balancesAfter,
      log: period.entries,
      leaves: period.leaves,
      root: period.root,
      verifyCommand: `node verify.js ${certPath}`,
    };
  }
}

module.exports = { Engine, LedgerError, EXIT, topoOrder };
