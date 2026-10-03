import { ClearingError, CODES } from './errors.js';
import { hashObject } from './canon.js';
import { RateBook, toBase } from './rates.js';
import {
  aggregateEdges,
  bilateralOffset,
  reduceCycles,
  netPositions,
  cycleTradeIds,
  sortedEdges,
} from './graph.js';
import { LockLedger } from './ledger.js';

export const RULES_VERSION = 'netting-rules/1.0.0';
export const ALGORITHM = 'bilateral+cycle-cancel/v1';

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function validateTrade(t) {
  if (t === null || typeof t !== 'object') {
    throw new ClearingError(CODES.INVALID_INPUT, 'trade must be an object');
  }
  for (const f of ['id', 'from', 'to', 'ccy']) {
    if (typeof t[f] !== 'string' || t[f].length === 0) {
      throw new ClearingError(CODES.INVALID_INPUT, `trade.${f} must be a non-empty string`);
    }
  }
  if (t.from === t.to) {
    throw new ClearingError(CODES.INVALID_INPUT, `trade ${t.id}: from and to must differ`);
  }
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) {
    throw new ClearingError(CODES.INVALID_INPUT, `trade ${t.id}: amount must be a positive safe integer`);
  }
}

export class ClearingEngine {
  #rateBook;
  #limits; // null => unlimited; object => per-participant, missing => 0
  #capacity; // null => unlimited
  #trades = new Map();
  #voided = new Set();
  #compCache = new Map(); // compId -> { memberKey, result }
  #stats = new Map(); // compId -> number of actual computations
  #locks = new Map(); // committed locks: participant -> amount
  #ledger = new LockLedger();
  #events = [];
  #committed = null; // last committed public result
  #lastRun = null;

  constructor({ base, limits = null, capacity = null } = {}) {
    this.#rateBook = new RateBook(base);
    if (limits !== null) {
      if (typeof limits !== 'object' || Array.isArray(limits)) {
        throw new ClearingError(CODES.INVALID_INPUT, 'limits must be an object or null');
      }
      for (const [p, v] of Object.entries(limits)) {
        if (!Number.isSafeInteger(v) || v < 0) {
          throw new ClearingError(CODES.INVALID_INPUT, `limit for ${p} must be a non-negative safe integer`);
        }
      }
    }
    if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0)) {
      throw new ClearingError(CODES.INVALID_INPUT, 'capacity must be a non-negative safe integer or null');
    }
    this.#limits = limits;
    this.#capacity = capacity;
  }

  get base() {
    return this.#rateBook.base;
  }

  get latestRatesVersion() {
    return this.#rateBook.latestVersion;
  }

  get result() {
    return this.#committed;
  }

  get events() {
    return this.#events.map((e) => ({ ...e }));
  }

  get lastRun() {
    return this.#lastRun;
  }

  // componentId -> number of times it was actually recomputed (test hook for
  // verifying that corrections/voids only touch affected components).
  get componentStats() {
    const out = {};
    for (const [k, v] of [...this.#stats.entries()].sort((a, b) => cmpStr(a[0], b[0]))) out[k] = v;
    return out;
  }

  addRateVersion(version, rates) {
    this.#rateBook.addVersion(version, rates);
  }

  setTrades(trades) {
    if (!Array.isArray(trades)) {
      throw new ClearingError(CODES.INVALID_INPUT, 'trades must be an array');
    }
    const map = new Map();
    for (const t of trades) {
      validateTrade(t);
      if (map.has(t.id)) {
        throw new ClearingError(CODES.INVALID_INPUT, `duplicate trade id ${t.id}`);
      }
      map.set(t.id, { id: t.id, from: t.from, to: t.to, ccy: t.ccy, amount: t.amount });
    }
    this.#trades = map;
    this.#voided = new Set();
    this.#compCache = new Map();
  }

  // Full settlement. ratesVersion defaults to the latest registered version;
  // asking for an older one raises RATE_STALE.
  settle({ ratesVersion } = {}) {
    return this.#run(ratesVersion ?? this.#requireLatest(), null);
  }

  // Correct one or more currency rates. Creates a new version (latest + 1)
  // and recomputes only the components touching the changed currencies.
  correctRates(patch) {
    const latest = this.#requireLatest();
    const cur = this.#rateBook.raw(latest);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ClearingError(CODES.INVALID_INPUT, 'correction must be an object {ccy: rate}');
    }
    const changed = [];
    for (const ccy of Object.keys(patch).sort()) {
      if (!(ccy in cur)) {
        throw new ClearingError(CODES.INVALID_INPUT, `cannot correct unknown currency ${ccy}`);
      }
      const r = patch[ccy];
      if (!Number.isSafeInteger(r) || r <= 0) {
        throw new ClearingError(CODES.INVALID_INPUT, `corrected rate for ${ccy} must be a positive integer`);
      }
      if (r !== cur[ccy]) changed.push(ccy);
    }
    if (changed.length === 0) {
      throw new ClearingError(CODES.INVALID_INPUT, 'correction changes nothing');
    }
    const next = { ...cur };
    for (const ccy of changed) next[ccy] = patch[ccy];
    this.#rateBook.addVersion(latest + 1, next);
    if (!this.#committed) return null;
    const affected = new Set();
    for (const t of this.#trades.values()) {
      if (!this.#voided.has(t.id) && changed.includes(t.ccy)) {
        affected.add(t.from);
        affected.add(t.to);
      }
    }
    return this.#run(latest + 1, affected);
  }

  // Void a trade and recompute only the component(s) it belonged to.
  voidTrade(id) {
    const t = this.#trades.get(id);
    if (!t) throw new ClearingError(CODES.INVALID_INPUT, `unknown trade ${id}`);
    if (this.#voided.has(id)) {
      throw new ClearingError(CODES.INVALID_INPUT, `trade ${id} is already voided`);
    }
    this.#voided.add(id);
    if (!this.#committed) return null;
    return this.#run(this.#rateBook.latestVersion, new Set([t.from, t.to]));
  }

  #requireLatest() {
    if (this.#rateBook.latestVersion === 0) {
      throw new ClearingError(CODES.INVALID_INPUT, 'no rate version registered');
    }
    return this.#rateBook.latestVersion;
  }

  #limitOf(p) {
    if (this.#limits === null) return Infinity;
    return this.#limits[p] ?? 0;
  }

  #partition(active) {
    const parent = new Map();
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      let c = x;
      while (parent.get(c) !== c) {
        const n = parent.get(c);
        parent.set(c, r);
        c = n;
      }
      return r;
    };
    for (const t of active) {
      if (!parent.has(t.from)) parent.set(t.from, t.from);
      if (!parent.has(t.to)) parent.set(t.to, t.to);
      parent.set(find(t.from), find(t.to));
    }
    const groups = new Map();
    for (const p of parent.keys()) {
      const r = find(p);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(p);
    }
    const comps = [...groups.values()].map((m) => m.sort());
    comps.sort((a, b) => cmpStr(a[0], b[0]));
    return comps.map((members) => {
      const set = new Set(members);
      return { id: members[0], members, trades: active.filter((t) => set.has(t.from)) };
    });
  }

  #computeComponent(trades) {
    const agg = aggregateEdges(trades);
    const bilat = bilateralOffset(agg);
    const { residual, cancelled, allCycles } = reduceCycles(bilat);
    return { bilat, residual, cancelled, allCycles, positions: netPositions(residual) };
  }

  // affected === null -> full recompute; otherwise only components containing
  // an affected participant (or whose trade set changed) are recomputed.
  #run(ratesVersion, affected) {
    const rates = this.#rateBook.current(ratesVersion); // RATE_STALE guard
    const active = [...this.#trades.values()]
      .filter((t) => !this.#voided.has(t.id))
      .sort((a, b) => cmpStr(a.id, b.id))
      .map((t) => {
        const r = rates[t.ccy];
        if (r === undefined) {
          throw new ClearingError(CODES.INVALID_INPUT, `no rate for currency ${t.ccy} (trade ${t.id})`);
        }
        return { ...t, baseAmount: toBase(t.amount, r) };
      });

    const components = this.#partition(active);
    const newCache = new Map();
    const results = new Map();
    const recomputed = [];
    for (const comp of components) {
      const memberKey = comp.trades.map((t) => t.id).join(',');
      const cached = this.#compCache.get(comp.id);
      const hit =
        affected !== null &&
        cached !== undefined &&
        cached.memberKey === memberKey &&
        !comp.members.some((m) => affected.has(m));
      if (hit) {
        newCache.set(comp.id, cached);
        results.set(comp.id, cached.result);
      } else {
        const result = this.#computeComponent(comp.trades);
        newCache.set(comp.id, { memberKey, result });
        results.set(comp.id, result);
        recomputed.push(comp.id);
        this.#stats.set(comp.id, (this.#stats.get(comp.id) ?? 0) + 1);
      }
    }

    // Merge component results.
    const netPos = new Map();
    const residualFlows = [];
    const cycles = [];
    for (const comp of components) {
      const res = results.get(comp.id);
      for (const m of comp.members) netPos.set(m, res.positions.get(m) ?? 0);
      for (const e of sortedEdges(res.residual)) {
        residualFlows.push({ from: e.from, to: e.to, amount: e.weight });
      }
      for (const c of res.cancelled) {
        cycles.push({ component: comp.id, nodes: c.nodes, amount: c.amount, tradeIds: c.tradeIds });
      }
    }
    const participants = [...netPos.keys()].sort();

    // Constraint checks, in canonical participant order: a deficient payer
    // inside a cycle is CYCLE_LOCKED, otherwise LIMIT. Then window capacity.
    for (const p of participants) {
      const lock = Math.max(0, -netPos.get(p));
      const limit = this.#limitOf(p);
      if (lock > limit) {
        const comp = components.find((c) => c.members.includes(p));
        const res = results.get(comp.id);
        const cyc = res.allCycles.find((c) => c.includes(p));
        if (cyc) {
          throw new ClearingError(
            CODES.CYCLE_LOCKED,
            `participant ${p} cannot fund net debit ${lock} (limit ${limit}) inside cycle ${cyc.join('->')}`,
            {
              participant: p,
              required: lock,
              limit,
              cycle: cyc,
              conflictSet: cycleTradeIds(res.bilat, cyc),
            },
          );
        }
        throw new ClearingError(
          CODES.LIMIT,
          `participant ${p} net debit ${lock} exceeds frozen limit ${limit}`,
          { participant: p, required: lock, limit },
        );
      }
    }
    let lockedTotal = 0;
    for (const p of participants) lockedTotal += Math.max(0, -netPos.get(p));
    if (this.#capacity !== null && lockedTotal > this.#capacity) {
      throw new ClearingError(
        CODES.LIMIT,
        `clearing window capacity exceeded: required ${lockedTotal}, capacity ${this.#capacity}`,
        { scope: 'window', required: lockedTotal, capacity: this.#capacity },
      );
    }

    // Commit: update ledger and event log.
    const newLocks = new Map();
    for (const p of participants) {
      const lock = Math.max(0, -netPos.get(p));
      if (lock > 0) newLocks.set(p, lock);
    }
    const full = affected === null || this.#committed === null;
    if (full) {
      this.#ledger = new LockLedger();
      this.#events = [];
      for (const [p, amt] of newLocks) {
        this.#ledger.lock(p, amt);
        this.#events.push({ seq: this.#events.length + 1, type: 'lock', participant: p, amount: amt, reason: 'settle' });
      }
    } else {
      const all = [...new Set([...this.#locks.keys(), ...newLocks.keys()])].sort();
      for (const p of all) {
        const o = this.#locks.get(p) ?? 0;
        const n = newLocks.get(p) ?? 0;
        if (n > o) {
          this.#ledger.lock(p, n - o);
          this.#events.push({ seq: this.#events.length + 1, type: 'lock', participant: p, amount: n - o, reason: 'increment' });
        } else if (o > n) {
          this.#ledger.release(p, o - n);
          this.#events.push({ seq: this.#events.length + 1, type: 'release', participant: p, amount: o - n, reason: 'release' });
        }
      }
    }
    this.#locks = newLocks;
    this.#compCache = newCache;

    const netPositionsObj = {};
    for (const p of participants) netPositionsObj[p] = netPos.get(p);
    const locksObj = {};
    for (const [p, amt] of newLocks) locksObj[p] = amt;

    const proofInput = {
      base: this.base,
      capacity: this.#capacity,
      limits: this.#limits ?? 'unlimited',
      rates: this.#rateBook.raw(ratesVersion),
      ratesVersion,
      rulesVersion: RULES_VERSION,
      trades: active.map(({ id, from, to, ccy, amount }) => ({ id, from, to, ccy, amount })),
      voided: [...this.#voided].sort(),
    };
    const result = {
      netPositions: netPositionsObj,
      locks: locksObj,
      residualFlows,
      cycles,
      window: { capacity: this.#capacity, locked: lockedTotal },
      proof: {
        algorithm: ALGORITHM,
        rulesVersion: RULES_VERSION,
        ratesVersion,
        inputHash: hashObject(proofInput),
      },
    };
    this.#committed = result;
    this.#lastRun = {
      mode: full ? 'full' : 'incremental',
      ratesVersion,
      recomputedComponents: recomputed.sort(),
    };
    return result;
  }
}
