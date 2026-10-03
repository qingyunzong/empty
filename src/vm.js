import { DslError, E_NEG, E_SEQ, E_SIGN, E_VERSION } from './errors.js';
import { SCALE, runCode, formatScaled } from './expr.js';

const ZERO_FREEZE = Object.freeze({ qty: 0n, cash: 0n });

function newCell() {
  return { heldQty: 0n, heldCash: 0n, frozenQty: 0n, frozenCash: 0n };
}

// Effective version of a trade: highest non-tombstoned version number;
// concurrent records at the same number are tie-broken by content hash.
export function effectiveOf(versions, tombstones) {
  let best = null;
  for (const [ver, recs] of versions) {
    if (tombstones.has(ver) || recs.length === 0) continue;
    const cand = recs.reduce((a, b) => (a.hash <= b.hash ? a : b));
    if (!best || ver > best.version) best = { version: ver, rec: cand };
  }
  return best;
}

export class VM {
  constructor() {
    this.scopes = new Map();   // tradeDate -> Map<tradeId, graph>
    this.ledger = new Map();   // `${date}|${isin}` -> cell
    this.seen = new Map();     // seq -> content hash (idempotent replay)
    this.lastSeq = 0;
    this.journal = [];         // append-only audit log of committed deltas
  }

  cell(date, isin) {
    const key = `${date}|${isin}`;
    let c = this.ledger.get(key);
    if (!c) { c = newCell(); this.ledger.set(key, c); }
    return c;
  }

  graph(date, id) {
    return this.scopes.get(date)?.get(id) ?? null;
  }

  // Freeze contribution of one effective version record.
  freezeOf(rec) {
    if (!rec) return ZERO_FREEZE;
    const price = runCode(rec.priceCode, {});
    const env = { qty: rec.qty * SCALE, price, accrued: rec.accrued };
    const fee = rec.feeCode ? runCode(rec.feeCode, env) : 0n;
    if (fee < 0n) throw new DslError(E_SIGN, `negative fee for ${rec.id} v${rec.version}`);
    const gross = rec.cls === 'bond' ? price + rec.accrued : price;
    if (rec.dir === 'buy') return { qty: 0n, cash: rec.qty * gross + fee };
    return { qty: rec.qty, cash: 0n };
  }

  // Tentatively apply a delta; commit only if every cell stays within
  // 0 <= frozen <= held. Otherwise the whole event is rejected (E_NEG)
  // and the ledger is left untouched.
  applyDelta(ev, oldFreeze, newFreeze) {
    const key = `${ev.date}|${ev.isin}`;
    const cell = this.ledger.get(key) ?? newCell();
    const dQty = newFreeze.qty - oldFreeze.qty;
    const dCash = newFreeze.cash - oldFreeze.cash;
    const nextQty = cell.frozenQty + dQty;
    const nextCash = cell.frozenCash + dCash;
    if (nextQty < 0n || nextCash < 0n) {
      throw new DslError(E_NEG, `freeze would go negative for ${ev.isin} on ${ev.date}`);
    }
    if (nextQty > cell.heldQty) {
      throw new DslError(E_NEG,
        `oversell: frozen qty ${nextQty} exceeds held ${cell.heldQty} for ${ev.isin} on ${ev.date}`);
    }
    if (nextCash > cell.heldCash) {
      throw new DslError(E_NEG,
        `insufficient cash: frozen ${formatScaled(nextCash)} exceeds held ${formatScaled(cell.heldCash)} for ${ev.isin} on ${ev.date}`);
    }
    cell.frozenQty = nextQty;
    cell.frozenCash = nextCash;
    this.ledger.set(key, cell); // commit only after all checks pass
    this.journal.push({ seq: this._seq, op: ev.op, id: ev.id ?? null,
      version: ev.version ?? null, cell: `${ev.date}|${ev.isin}`,
      dQty, dCash });
  }

  apply(ev, seq) {
    if (seq !== undefined && seq !== null) {
      if (!Number.isInteger(seq) || seq <= 0) {
        throw new DslError(E_SEQ, `seq must be a positive integer, got ${seq}`);
      }
      const prior = this.seen.get(seq);
      if (prior !== undefined) {
        if (prior === ev.hash) return { ok: true, noop: true }; // idempotent replay
        throw new DslError(E_SEQ, `conflicting event for seq ${seq}`);
      }
      if (seq < this.lastSeq) {
        throw new DslError(E_SEQ, `seq ${seq} goes backwards (last ${this.lastSeq})`);
      }
    }
    this._seq = seq ?? null;
    switch (ev.op) {
      case 'DEPOSIT': this.applyDeposit(ev); break;
      case 'NEW_TRADE': this.applyNewTrade(ev); break;
      case 'NEW_VERSION': this.applyNewVersion(ev); break;
      case 'TOMBSTONE': this.applyTombstone(ev); break;
      default: throw new Error(`bad opcode ${ev.op}`);
    }
    if (seq !== undefined && seq !== null) {
      this.seen.set(seq, ev.hash);
      this.lastSeq = seq;
    }
    return { ok: true, noop: false };
  }

  applyDeposit(ev) {
    const cell = this.cell(ev.date, ev.isin);
    cell.heldQty += ev.qty;
    cell.heldCash += ev.cash;
    this.journal.push({ seq: this._seq, op: 'DEPOSIT', id: null, version: null,
      cell: `${ev.date}|${ev.isin}`, dQty: ev.qty, dCash: ev.cash });
  }

  applyNewTrade(ev) {
    if (ev.version !== 1) {
      throw new DslError(E_VERSION, `new trade ${ev.id} must start at v1, got v${ev.version}`);
    }
    let scope = this.scopes.get(ev.date);
    if (!scope) { scope = new Map(); this.scopes.set(ev.date, scope); }
    if (scope.has(ev.id)) {
      throw new DslError(E_VERSION, `trade ${ev.id} already exists in scope ${ev.date}`);
    }
    const versions = new Map([[1, [this.recordOf(ev)]]]);
    const graph = { dir: ev.dir, isin: ev.isin, cls: ev.cls, date: ev.date,
      versions, tombstones: new Set() };
    // delta from "no effective version" to v1
    this.applyDelta(ev, ZERO_FREEZE, this.freezeOf(versions.get(1)[0]));
    scope.set(ev.id, graph);
  }

  applyNewVersion(ev) {
    const graph = this.graph(ev.date, ev.id);
    if (!graph) {
      throw new DslError(E_VERSION,
        `amend references unknown trade ${ev.id} in scope ${ev.date}`);
    }
    if (ev.version < 2) {
      throw new DslError(E_VERSION, `amend version must be >= 2, got v${ev.version}`);
    }
    if (ev.dir !== graph.dir) {
      throw new DslError(E_SIGN,
        `amend cannot flip direction ${graph.dir} -> ${ev.dir} for ${ev.id}`);
    }
    if (ev.isin !== graph.isin) {
      throw new DslError(E_SIGN,
        `amend cannot change instrument ${graph.isin} -> ${ev.isin} for ${ev.id}`);
    }
    const rec = this.recordOf(ev);
    const next = new Map(graph.versions);
    next.set(ev.version, [...(next.get(ev.version) ?? []), rec]);
    const oldEff = effectiveOf(graph.versions, graph.tombstones);
    const newEff = effectiveOf(next, graph.tombstones);
    this.applyDelta(ev, this.freezeOf(oldEff?.rec ?? null), this.freezeOf(newEff?.rec ?? null));
    graph.versions = next; // commit only after delta succeeds
  }

  applyTombstone(ev) {
    const graph = this.graph(ev.date, ev.id);
    if (!graph) {
      throw new DslError(E_VERSION,
        `cancel references unknown trade ${ev.id} in scope ${ev.date}`);
    }
    if (graph.tombstones.has(ev.version)) return; // already revoked: no-op
    const next = new Set(graph.tombstones);
    next.add(ev.version); // pending tombstones are allowed: version may arrive later
    const oldEff = effectiveOf(graph.versions, graph.tombstones);
    const newEff = effectiveOf(graph.versions, next);
    this.applyDelta({ ...ev, isin: graph.isin },
      this.freezeOf(oldEff?.rec ?? null), this.freezeOf(newEff?.rec ?? null));
    graph.tombstones = next;
  }

  recordOf(ev) {
    return { id: ev.id, version: ev.version, dir: ev.dir, qty: ev.qty,
      isin: ev.isin, cls: ev.cls, accrued: ev.accrued,
      priceCode: ev.priceCode, feeCode: ev.feeCode, hash: ev.hash };
  }

  state() {
    const ledger = {};
    for (const [key, c] of [...this.ledger.entries()].sort()) {
      ledger[key] = {
        heldQty: c.heldQty.toString(),
        frozenQty: c.frozenQty.toString(),
        heldCash: formatScaled(c.heldCash),
        frozenCash: formatScaled(c.frozenCash),
      };
    }
    const scopes = {};
    for (const [date, scope] of [...this.scopes.entries()].sort()) {
      const trades = {};
      for (const [id, g] of [...scope.entries()].sort()) {
        const eff = effectiveOf(g.versions, g.tombstones);
        trades[id] = {
          direction: g.dir,
          effective: eff ? { version: eff.version, hash: eff.rec.hash.slice(0, 12) } : null,
          versions: [...g.versions.keys()].sort((a, b) => a - b),
          tombstones: [...g.tombstones].sort((a, b) => a - b),
        };
      }
      scopes[date] = trades;
    }
    return { lastSeq: this.lastSeq, ledger, scopes };
  }
}
