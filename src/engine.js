'use strict';

const { ReconError, CODES } = require('./errors');
const { PURPOSES } = require('./registry');
const { parseUtcIso } = require('./time');
const { utcToLocal, localToUtc } = require('./convert');
const { parseAmount, applyRate } = require('./money');

// Build fee-rate intervals: local-time effective ranges converted to UTC
// half-open intervals [startUtcMs, endUtcMs) using the pinned fee table.
function buildIntervals(rates, feeTable, zone, policy, evidence) {
  const intervals = (rates || []).map((r) => {
    if (!r.id) throw new ReconError(CODES.E_POLICY, 'rate interval missing id');
    const start = localToUtc(feeTable, zone, r.startLocal, policy, evidence);
    const end = localToUtc(feeTable, zone, r.endLocal, policy, evidence);
    if (end.utcMs <= start.utcMs) {
      throw new ReconError(CODES.E_POLICY,
        `rate interval ${r.id} is empty or inverted after tz resolution`);
    }
    return {
      id: r.id,
      startUtcMs: start.utcMs,
      endUtcMs: end.utcMs,
      startLocal: r.startLocal,
      endLocal: r.endLocal,
      rate: r.rate,
      fx: r.fx,
    };
  });
  intervals.sort((a, b) => a.startUtcMs - b.startUtcMs);
  return intervals;
}

function hitIntervals(intervals, utcMs) {
  return intervals.filter((i) => i.startUtcMs <= utcMs && utcMs < i.endUtcMs);
}

class ReconEngine {
  constructor(registry) {
    this.registry = registry;
    // Finalized history: settlement day -> pinned version tuple.
    // History is append-only; recomputation must reuse the pinned versions.
    this.finalized = new Map();
  }

  pinnedTables(pinned) {
    if (!pinned || typeof pinned !== 'object') {
      throw new ReconError(CODES.E_TZVER, 'input requires "pinned" table versions');
    }
    const out = {};
    for (const p of PURPOSES) {
      if (typeof pinned[p] !== 'string') {
        throw new ReconError(CODES.E_TZVER, `missing pinned version for purpose ${p}`);
      }
      out[p] = this.registry.get(p, pinned[p]);
    }
    return out;
  }

  // input: {zone, policy, pinned, rates, transactions, settlements, corrections}
  // opts:  {finalize: boolean}
  reconcile(input, opts = {}) {
    const zone = input.zone;
    const policy = input.policy || 'strict';
    const tables = this.pinnedTables(input.pinned);
    const versions = { txn: tables.txn.version, settlement: tables.settlement.version, fee: tables.fee.version };
    const evidence = [];

    const intervals = buildIntervals(input.rates, tables.fee, zone, policy, evidence);
    const txnZone = tables.txn.zones.get(zone);
    if (!txnZone) {
      throw new ReconError(CODES.E_TZVER,
        `zone ${zone} not present in txn table version ${tables.txn.version}`);
    }

    // --- process transactions ---
    const txns = new Map(); // id -> computed record
    const dayBuckets = new Map(); // settlement day -> {expectedNet, txnIds}
    const rateHits = [];

    const addToDay = (day, txnId, net) => {
      let b = dayBuckets.get(day);
      if (!b) { b = { expectedNet: 0n, txnIds: [] }; dayBuckets.set(day, b); }
      b.expectedNet += net;
      b.txnIds.push(txnId);
    };

    const computeTxn = (t) => {
      const utcMs = parseUtcIso(t.utc, txnZone.leapMap);
      const local = utcToLocal(tables.settlement, zone, utcMs);
      const hits = hitIntervals(intervals, utcMs);
      const amountMinor = parseAmount(t.amount, `amount of txn ${t.id}`);
      let fee = 0n;
      let fxApplied = amountMinor;
      let hit = null;
      if (hits.length > 0) {
        hit = hits[hits.length - 1]; // latest-starting interval wins on overlap
        fee = applyRate(amountMinor, hit.rate, `rate of interval ${hit.id}`);
        fxApplied = applyRate(amountMinor, hit.fx, `fx of interval ${hit.id}`);
        rateHits.push({
          txnId: t.id,
          intervalId: hit.id,
          rate: hit.rate,
          fx: hit.fx,
          feeTableVersion: tables.fee.version,
        });
      }
      return { id: t.id, utcMs, day: local.day, amountMinor, fee, net: fxApplied - fee, hit };
    };

    for (const t of input.transactions || []) {
      if (txns.has(t.id)) {
        throw new ReconError(CODES.E_POLICY, `duplicate transaction id ${t.id}`);
      }
      const rec = computeTxn(t);
      txns.set(t.id, rec);
      addToDay(rec.day, rec.id, rec.net);
    }

    // --- corrections: recompute only intersecting fee intervals / days ---
    const impactSet = { intervals: new Set(), days: new Set(), transactions: new Set() };
    for (const c of input.corrections || []) {
      const old = txns.get(c.supersedes);
      if (!old) {
        throw new ReconError(CODES.E_POLICY, `correction ${c.id} supersedes unknown txn ${c.supersedes}`);
      }
      const rec = computeTxn({ id: c.id, utc: c.utc, amount: c.amount });
      txns.set(c.id, rec);
      // impact = fee intervals containing old OR new instant
      for (const i of hitIntervals(intervals, old.utcMs)) impactSet.intervals.add(i.id);
      for (const i of hitIntervals(intervals, rec.utcMs)) impactSet.intervals.add(i.id);
      impactSet.days.add(old.day);
      impactSet.days.add(rec.day);
      impactSet.transactions.add(c.supersedes);
      impactSet.transactions.add(c.id);
      // remove old contribution, add new
      const oldBucket = dayBuckets.get(old.day);
      oldBucket.expectedNet -= old.net;
      addToDay(rec.day, rec.id, rec.net);
    }

    // --- replay guard: history is pinned to its original versions ---
    for (const day of dayBuckets.keys()) {
      const pinnedTuple = this.finalized.get(day);
      if (pinnedTuple) {
        const same = PURPOSES.every((p) => pinnedTuple[p] === versions[p]);
        if (!same) {
          throw new ReconError(CODES.E_REPLAY,
            `settlement day ${day} was finalized with versions ${JSON.stringify(pinnedTuple)}; ` +
            `refusing to rewrite history with ${JSON.stringify(versions)}`);
        }
      }
    }

    // --- reconciliation differences vs actual settlements ---
    const actualByDay = new Map();
    for (const s of input.settlements || []) {
      actualByDay.set(s.day, parseAmount(s.amount, `settlement amount of ${s.day}`));
    }
    const differences = [];
    const allDays = new Set([...dayBuckets.keys(), ...actualByDay.keys()]);
    for (const day of [...allDays].sort()) {
      const expected = dayBuckets.has(day) ? dayBuckets.get(day).expectedNet : null;
      const actual = actualByDay.has(day) ? actualByDay.get(day) : null;
      let status;
      if (expected === null) status = 'missing_expected';
      else if (actual === null) status = 'missing_actual';
      else status = expected === actual ? 'match' : 'mismatch';
      differences.push({
        day,
        expected: expected === null ? null : expected.toString(),
        actual: actual === null ? null : actual.toString(),
        diff: expected !== null && actual !== null ? (actual - expected).toString() : null,
        status,
      });
    }

    if (opts.finalize) {
      for (const day of dayBuckets.keys()) {
        if (!this.finalized.has(day)) this.finalized.set(day, { ...versions });
      }
    }

    return {
      versions,
      zone,
      policy,
      days: Object.fromEntries([...dayBuckets.entries()].sort().map(([d, b]) => [d, {
        expectedNet: b.expectedNet.toString(),
        transactions: b.txnIds,
      }])),
      differences,
      rateHits,
      impactSet: {
        intervals: [...impactSet.intervals].sort(),
        days: [...impactSet.days].sort(),
        transactions: [...impactSet.transactions].sort(),
      },
      evidence,
    };
  }
}

module.exports = { ReconEngine, buildIntervals, hitIntervals };
