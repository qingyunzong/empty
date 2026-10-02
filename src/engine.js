import { toUnits, fmt, mulUnits } from './decimal.js';
import { NettingError, ErrorCodes } from './errors.js';
import { RateTable } from './rates.js';
import { canonical, sha256hex } from './canon.js';
import { stronglyConnectedComponents, findCycle, canonicalCycle } from './graph.js';

export const RULES_VERSION = 'netting-rules/1.0.0';

const edgeKey = (from, to) => JSON.stringify([from, to]);

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// NettingEngine holds mutable clearing state plus an operation journal.
// Mutations (addTrades / voidTrade / correctRate) are journaled so the exact
// state can be replayed from scratch; settle() recomputes only the netting
// components (SCCs) whose edge content changed since the last settle.
export class NettingEngine {
  constructor(config = {}) {
    const { rates = null, limits = null, windowCapacity = null } = config;
    const base = rates?.base ?? config.base ?? 'USD';
    this.rateTable = rates
      ? new RateTable(rates)
      : new RateTable({ base, versions: [{ version: 1, rates: {} }] });
    this.base = this.rateTable.base;
    this.limits = parseLimits(limits);
    this.windowCapacity = parseOptionalUnits(windowCapacity, 'windowCapacity');
    this.trades = new Map(); // id -> {id, from, to, currency, amount(units)}
    this.voided = new Set();
    this.journal = [];
    this.initialConfig = {
      base,
      rates: rates ? structuredClone(rates) : null,
      limits: limits ? structuredClone(limits) : null,
      windowCapacity: windowCapacity ?? null,
    };
    this.reductionCache = new Map(); // scc content hash -> reduction
    this.dirty = { tradeIds: new Set(), currencies: new Set(), parties: new Set() };
    this.lastTrace = null;
  }

  addTrades(trades) {
    if (!Array.isArray(trades)) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, 'trades must be an array');
    }
    for (const t of trades) this.#addTrade(t);
    this.journal.push({ op: 'addTrades', trades: trades.map((t) => ({ ...t })) });
  }

  #addTrade(t) {
    if (t === null || typeof t !== 'object') {
      throw new NettingError(ErrorCodes.INPUT_INVALID, 'trade must be an object');
    }
    const { id, from, to, currency } = t;
    for (const [field, v] of [['id', id], ['from', from], ['to', to], ['currency', currency]]) {
      if (typeof v !== 'string' || v.length === 0) {
        throw new NettingError(ErrorCodes.INPUT_INVALID, `trade: "${field}" must be a non-empty string`);
      }
    }
    if (this.trades.has(id)) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, `duplicate trade id ${id}`);
    }
    if (from === to) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, `trade ${id}: self-trade is not allowed`);
    }
    let amount;
    try {
      amount = toUnits(t.amount, `amount of trade ${id}`);
    } catch (e) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, e.message);
    }
    if (amount <= 0n) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, `trade ${id}: amount must be positive`);
    }
    this.trades.set(id, { id, from, to, currency, amount });
    this.dirty.tradeIds.add(id);
    this.dirty.parties.add(from).add(to);
  }

  // Voiding releases the frozen capacity attributable to the trade on the
  // next settle. Voiding an unknown or already-voided trade would release
  // capacity that is not locked, so it fails with NEGATIVE_RELEASE.
  voidTrade(id) {
    const t = this.trades.get(id);
    if (!t || this.voided.has(id)) {
      throw new NettingError(
        ErrorCodes.NEGATIVE_RELEASE,
        `cannot void trade ${id}: ${t ? 'already voided' : 'unknown trade'} (release would exceed locked amount)`,
        { tradeId: id },
      );
    }
    this.voided.add(id);
    this.dirty.tradeIds.add(id);
    this.dirty.parties.add(t.from).add(t.to);
    this.journal.push({ op: 'voidTrade', id });
  }

  // Append a new rates version correcting one currency. Returns the new
  // version number. Only netting components containing trades in this
  // currency are recomputed on the next settle.
  correctRate(currency, rate) {
    if (typeof currency !== 'string' || currency.length === 0) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, 'correctRate: currency must be a non-empty string');
    }
    const version = this.rateTable.correct(currency, rate);
    this.dirty.currencies.add(currency);
    this.journal.push({ op: 'correctRate', currency, rate });
    return version;
  }

  #limitOf(party) {
    if (this.limits === null) return null; // unlimited
    return this.limits.get(party) ?? 0n;
  }

  settle({ ratesVersion } = {}) {
    const version = ratesVersion ?? this.rateTable.currentVersion;
    const rates = this.rateTable.effective(version); // throws RATE_STALE

    // 1. Convert active trades to base currency and aggregate per ordered pair.
    const edges = new Map(); // from SEP to -> {from, to, amount, tradeIds}
    const parties = new Set();
    const sortedTrades = [...this.trades.values()].sort((a, b) => cmpStr(a.id, b.id));
    for (const t of sortedTrades) {
      if (this.voided.has(t.id)) continue;
      const rate = rates.get(t.currency);
      if (rate === undefined) {
        throw new NettingError(
          ErrorCodes.RATE_MISSING,
          `no rate for currency ${t.currency} at version ${version}`,
          { currency: t.currency, ratesVersion: version },
        );
      }
      const amount = mulUnits(t.amount, rate);
      parties.add(t.from).add(t.to);
      const key = edgeKey(t.from, t.to);
      let e = edges.get(key);
      if (!e) {
        e = { from: t.from, to: t.to, amount: 0n, tradeIds: [] };
        edges.set(key, e);
      }
      e.amount += amount;
      e.tradeIds.push(t.id);
    }
    for (const e of edges.values()) e.tradeIds.sort();

    const nodes = [...parties].sort();
    const adj = new Map(nodes.map((n) => [n, []]));
    for (const e of edges.values()) {
      if (e.amount > 0n) adj.get(e.from).push(e.to);
    }
    for (const a of adj.values()) a.sort();

    // 2. Decompose into SCCs; cycles live entirely inside one SCC.
    const sccs = stronglyConnectedComponents(nodes, adj);
    const compOf = new Map();
    sccs.forEach((comp, ci) => comp.forEach((n) => compOf.set(n, ci)));

    // 3. Reduce each non-trivial SCC (cycle netting), using the incremental
    //    cache keyed by exact edge content. Unaffected components are reused.
    const finalEdges = [];
    const traceComponents = [];
    let hits = 0;
    let misses = 0;
    sccs.forEach((comp) => {
      if (comp.length < 2) return;
      const inComp = new Set(comp);
      const internal = [...edges.values()].filter(
        (e) => e.amount > 0n && inComp.has(e.from) && inComp.has(e.to),
      );
      const key = sha256hex(canonical(
        internal
          .map((e) => [e.from, e.to, fmt(e.amount), e.tradeIds])
          .sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1])),
      ));
      let reduction = this.reductionCache.get(key);
      let recomputed = false;
      if (!reduction) {
        reduction = this.#reduceComponent(comp, internal);
        this.reductionCache.set(key, reduction);
        recomputed = true;
        misses += 1;
      } else {
        hits += 1;
      }
      finalEdges.push(...reduction.edges);
      traceComponents.push({ parties: comp, recomputed, cycles: reduction.cycles.length });
    });

    // 4. Cross-component edges are never on a cycle; they pass through.
    for (const e of edges.values()) {
      if (e.amount > 0n && compOf.get(e.from) !== compOf.get(e.to)) {
        finalEdges.push({ from: e.from, to: e.to, amount: e.amount, tradeIds: [...e.tradeIds] });
      }
    }
    finalEdges.sort((a, b) => cmpStr(a.from, b.from) || cmpStr(a.to, b.to));

    // 5. Frozen-capacity check on the netted (acyclic) obligations.
    const pay = new Map(nodes.map((n) => [n, 0n]));
    const receive = new Map(nodes.map((n) => [n, 0n]));
    for (const e of finalEdges) {
      pay.set(e.from, pay.get(e.from) + e.amount);
      receive.set(e.to, receive.get(e.to) + e.amount);
    }
    for (const p of nodes) {
      const lim = this.#limitOf(p);
      if (lim !== null && pay.get(p) > lim) {
        throw new NettingError(
          ErrorCodes.LIMIT,
          `party ${p}: net obligation ${fmt(pay.get(p))} exceeds frozen limit ${fmt(lim)}`,
          { scope: 'party', party: p, required: fmt(pay.get(p)), available: fmt(lim) },
        );
      }
    }

    // 6. Clearing-window capacity check.
    let used = 0n;
    for (const v of pay.values()) used += v;
    if (this.windowCapacity !== null && used > this.windowCapacity) {
      throw new NettingError(
        ErrorCodes.LIMIT,
        `clearing window capacity exceeded: ${fmt(used)} > ${fmt(this.windowCapacity)}`,
        { scope: 'window', required: fmt(used), available: fmt(this.windowCapacity) },
      );
    }

    // 7. Outputs (all amounts as decimal strings; arrays sorted).
    const netPositions = nodes.map((p) => ({
      party: p,
      net: fmt(receive.get(p) - pay.get(p)),
      pay: fmt(pay.get(p)),
      receive: fmt(receive.get(p)),
    }));
    const locks = nodes.map((p) => {
      const lim = this.#limitOf(p);
      return {
        party: p,
        locked: fmt(pay.get(p)),
        limit: lim === null ? null : fmt(lim),
        available: lim === null ? null : fmt(lim - pay.get(p)),
      };
    });
    const netObligations = finalEdges.map((e) => ({
      from: e.from,
      to: e.to,
      amount: fmt(e.amount),
      trades: e.tradeIds,
    }));

    const activeTrades = sortedTrades
      .filter((t) => !this.voided.has(t.id))
      .map((t) => ({ id: t.id, from: t.from, to: t.to, currency: t.currency, amount: fmt(t.amount) }));
    const proofInput = {
      base: this.base,
      trades: activeTrades,
      rates: [...rates.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([c, r]) => [c, fmt(r)]),
      limits: this.limits === null
        ? null
        : [...this.limits.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([p, l]) => [p, fmt(l)]),
      windowCapacity: this.windowCapacity === null ? null : fmt(this.windowCapacity),
      rulesVersion: RULES_VERSION,
    };
    const proof = {
      inputHash: sha256hex(canonical(proofInput)),
      rulesVersion: RULES_VERSION,
      ratesVersion: version,
      base: this.base,
    };

    const affectedParties = new Set(this.dirty.parties);
    for (const t of sortedTrades) {
      if (!this.voided.has(t.id) && this.dirty.currencies.has(t.currency)) {
        affectedParties.add(t.from).add(t.to);
      }
    }
    const trace = {
      ratesVersion: version,
      components: traceComponents,
      affected: {
        tradeIds: [...this.dirty.tradeIds].sort(),
        currencies: [...this.dirty.currencies].sort(),
        parties: [...affectedParties].sort(),
      },
      cache: { hits, misses },
    };
    this.dirty = { tradeIds: new Set(), currencies: new Set(), parties: new Set() };
    this.lastTrace = trace;

    return {
      ok: true,
      netPositions,
      locks,
      netObligations,
      window: { capacity: this.windowCapacity === null ? null : fmt(this.windowCapacity), used: fmt(used) },
      proof,
      trace,
    };
  }

  // Cycle-nett one SCC. A pending cycle is never treated as unsatisfiable:
  // it is resolved by subtracting its bottleneck, unless some party on the
  // cycle cannot freeze the bottleneck amount -> CYCLE_LOCKED with the
  // minimal conflict set (elementary cycle + exactly the deficient parties).
  #reduceComponent(comp, internal) {
    const local = new Map();
    for (const e of internal) {
      local.set(edgeKey(e.from, e.to), { from: e.from, to: e.to, amount: e.amount, tradeIds: [...e.tradeIds] });
    }
    const cycles = [];

    // Phase 1: bilateral offsets for every mutual pair, in sorted pair order.
    // Bilateral netting always runs before multilateral cycle reduction; this
    // keeps the reduction canonical and guarantees settlement volume never
    // exceeds the pairwise-netted baseline.
    for (let i = 0; i < comp.length; i += 1) {
      for (let j = i + 1; j < comp.length; j += 1) {
        const fwd = local.get(edgeKey(comp[i], comp[j]));
        const rev = local.get(edgeKey(comp[j], comp[i]));
        if (!fwd || !rev) continue;
        const off = fwd.amount < rev.amount ? fwd.amount : rev.amount;
        const unionIds = [...new Set([...fwd.tradeIds, ...rev.tradeIds])].sort();
        this.#assertCycleCapacity([comp[i], comp[j]], off, unionIds);
        fwd.amount -= off;
        rev.amount -= off;
        for (const e of [fwd, rev]) {
          if (e.amount === 0n) local.delete(edgeKey(e.from, e.to));
          else e.tradeIds = unionIds;
        }
        cycles.push({ nodes: [comp[i], comp[j]], bottleneck: off });
      }
    }

    // Phase 2: multilateral cycle reduction on the remaining graph.
    for (;;) {
      const adj = new Map(comp.map((n) => [n, []]));
      for (const e of local.values()) {
        if (e.amount > 0n) adj.get(e.from).push(e.to);
      }
      for (const a of adj.values()) a.sort();
      const found = findCycle(comp, adj);
      if (!found) break;
      const cycle = canonicalCycle(found);

      const cycleEdges = [];
      let bottleneck = null;
      for (let i = 0; i < cycle.length; i += 1) {
        const e = local.get(edgeKey(cycle[i], cycle[(i + 1) % cycle.length]));
        cycleEdges.push(e);
        if (bottleneck === null || e.amount < bottleneck) bottleneck = e.amount;
      }

      const tradeIds = [...new Set(cycleEdges.flatMap((e) => e.tradeIds))].sort();
      this.#assertCycleCapacity(cycle, bottleneck, tradeIds);

      // Subtract the bottleneck from every cycle edge. Trade provenance of
      // consumed edges is merged into the surviving cycle edges so the
      // residual obligations keep a full audit trail of the netting.
      const unionIds = [...new Set(cycleEdges.flatMap((e) => e.tradeIds))].sort();
      for (const e of cycleEdges) {
        e.amount -= bottleneck;
        if (e.amount === 0n) {
          local.delete(edgeKey(e.from, e.to));
        } else {
          e.tradeIds = [...new Set([...e.tradeIds, ...unionIds])].sort();
        }
      }
      cycles.push({ nodes: cycle, bottleneck });
    }
    return { edges: [...local.values()].filter((e) => e.amount > 0n), cycles };
  }

  // Throw CYCLE_LOCKED with the minimal conflict set if any party on the
  // cycle cannot freeze the bottleneck amount.
  #assertCycleCapacity(cycle, bottleneck, tradeIds) {
    const deficient = [];
    for (const p of cycle) {
      const lim = this.#limitOf(p);
      if (lim !== null && lim < bottleneck) {
        deficient.push({ party: p, required: fmt(bottleneck), available: fmt(lim) });
      }
    }
    if (deficient.length > 0) {
      throw new NettingError(
        ErrorCodes.CYCLE_LOCKED,
        `cycle ${cycle.join(' -> ')} -> ${cycle[0]} cannot be netted: frozen capacity below bottleneck ${fmt(bottleneck)}`,
        {
          cycle,
          bottleneck: fmt(bottleneck),
          conflict: { parties: deficient, trades: tradeIds },
        },
      );
    }
  }

  // Rebuild a fresh engine from the initial config plus the journal and
  // return it. Settling the replayed engine must reproduce the exact state.
  replay() {
    const eng = new NettingEngine(this.initialConfig);
    for (const op of this.journal) {
      if (op.op === 'addTrades') eng.addTrades(op.trades);
      else if (op.op === 'voidTrade') eng.voidTrade(op.id);
      else if (op.op === 'correctRate') eng.correctRate(op.currency, op.rate);
    }
    return eng;
  }
}

function parseLimits(limits) {
  if (limits === null || limits === undefined) return null; // unconstrained
  const map = new Map();
  for (const [party, v] of Object.entries(limits)) {
    let units;
    try {
      units = toUnits(v, `limit of ${party}`);
    } catch (e) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, e.message);
    }
    if (units < 0n) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, `limit of ${party} must be non-negative`);
    }
    map.set(party, units);
  }
  return map;
}

function parseOptionalUnits(value, what) {
  if (value === null || value === undefined) return null;
  let units;
  try {
    units = toUnits(value, what);
  } catch (e) {
    throw new NettingError(ErrorCodes.INPUT_INVALID, e.message);
  }
  if (units < 0n) {
    throw new NettingError(ErrorCodes.INPUT_INVALID, `${what} must be non-negative`);
  }
  return units;
}
