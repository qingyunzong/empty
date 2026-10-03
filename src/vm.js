import { parse } from './parser.js';
import { check } from './checker.js';
import { compile } from './compiler.js';
import { EscrowError } from './errors.js';
import { eventHash, recordHash } from './hash.js';
import { round6, zeroEntry, isZeroEntry, normalizeEntry } from './util.js';

// Effective record of a trade: highest non-tombstoned version; concurrent
// records at the same version are tie-broken by content hash (lexicographic).
export function effectiveOf(trade) {
  let bestVer = -1;
  for (const v of trade.versions.keys()) {
    if (trade.tombstones.has(v)) continue;
    if (trade.versions.get(v).size === 0) continue;
    if (v > bestVer) bestVer = v;
  }
  if (bestVer < 0) return null;
  let best = null;
  for (const rec of trade.versions.get(bestVer).values()) {
    if (best === null || rec.hash < best.hash) best = rec;
  }
  return best;
}

function cloneTrades(trades) {
  const out = new Map();
  for (const [id, t] of trades) {
    const versions = new Map();
    for (const [v, m] of t.versions) versions.set(v, new Map(m));
    out.set(id, { id: t.id, date: t.date, versions, tombstones: new Set(t.tombstones) });
  }
  return out;
}

export class VM {
  constructor() {
    this.lastSeq = 0;
    this.lastHash = null;
    this.trades = new Map();
    this.ledger = new Map();
    this._touched = new Set();
  }

  // Apply one {seq, text} event. Never throws for domain errors; returns
  // {ok:true, skipped?} or {ok:false, code, message}. On failure the VM
  // state is left untouched.
  applyEvent(evt) {
    if (!evt || !Number.isInteger(evt.seq) || evt.seq < 1 || typeof evt.text !== 'string') {
      return { ok: false, code: 'E_SEQ', message: 'event must have integer seq >= 1 and string text' };
    }
    const hash = eventHash(evt);
    if (evt.seq === this.lastSeq && hash === this.lastHash) {
      return { ok: true, skipped: true }; // idempotent replay of the last event
    }
    if (evt.seq !== this.lastSeq + 1) {
      return { ok: false, code: 'E_SEQ', message: `expected seq ${this.lastSeq + 1}, got ${evt.seq}` };
    }
    let stmt;
    try {
      stmt = check(parse(evt.text));
    } catch (e) {
      if (e instanceof EscrowError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
    const program = compile(stmt);
    const workTrades = cloneTrades(this.trades);
    const workLedger = new Map();
    for (const [k, e] of this.ledger) workLedger.set(k, { ...e });
    try {
      this.execute(program, workTrades, workLedger);
    } catch (e) {
      if (e instanceof EscrowError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
    this.trades = workTrades;
    this.ledger = workLedger;
    this.lastSeq = evt.seq;
    this.lastHash = hash;
    return { ok: true };
  }

  execute(program, trades, ledger) {
    const stack = [];
    this._touched = new Set();
    for (const ins of program) {
      switch (ins.op) {
        case 'PUSH': stack.push(ins.value); break;
        case 'ADD': { const b = stack.pop(); const a = stack.pop(); stack.push(a + b); break; }
        case 'SUB': { const b = stack.pop(); const a = stack.pop(); stack.push(a - b); break; }
        case 'MUL': { const b = stack.pop(); const a = stack.pop(); stack.push(a * b); break; }
        case 'DIV': { const b = stack.pop(); const a = stack.pop(); stack.push(a / b); break; }
        case 'NEG': stack.push(-stack.pop()); break;
        case 'NEW_TRADE':
        case 'AMEND': {
          const fee = stack.pop();
          const price = stack.pop();
          const rec = {
            id: ins.id, version: ins.version, date: ins.date, side: ins.side,
            qty: ins.qty, isin: ins.isin, priceKind: ins.priceKind,
            price: round6(price), fee: round6(fee),
          };
          rec.hash = recordHash(rec);
          this.applyRecord(ins.op === 'NEW_TRADE', rec, trades, ledger);
          break;
        }
        case 'REVOKE':
          this.applyRevoke(ins, trades, ledger);
          break;
        default:
          throw new EscrowError('E_PARSE', `unknown opcode ${ins.op}`);
      }
    }
    // Non-negativity invariant on every ledger line touched by this event.
    for (const key of this._touched) {
      const e = ledger.get(key);
      if (e.bought - e.sold < 0) {
        throw new EscrowError('E_NEG', `oversell on ${key}: net shares ${e.bought - e.sold}`);
      }
      if (e.frozenShares < 0 || e.frozenCash < 0 || e.proceeds < 0) {
        throw new EscrowError('E_NEG', `negative freeze on ${key}`);
      }
    }
  }

  applyRecord(isNew, rec, trades, ledger) {
    let trade = trades.get(rec.id);
    if (isNew) {
      if (trade) throw new EscrowError('E_VERSION', `trade ${rec.id} already exists; use amend`);
      trade = { id: rec.id, date: rec.date, versions: new Map(), tombstones: new Set() };
      trades.set(rec.id, trade);
    } else {
      if (!trade) throw new EscrowError('E_VERSION', `amend references unknown trade ${rec.id}`);
      if (trade.date !== rec.date) {
        throw new EscrowError('E_VERSION', `amend of ${rec.id} dated ${rec.date} outside trade date scope ${trade.date}`);
      }
    }
    const oldEff = effectiveOf(trade);
    let byVer = trade.versions.get(rec.version);
    if (!byVer) { byVer = new Map(); trade.versions.set(rec.version, byVer); }
    byVer.set(rec.hash, rec);
    const newEff = effectiveOf(trade);
    this.applyDelta(oldEff, newEff, ledger);
  }

  applyRevoke(ins, trades, ledger) {
    const trade = trades.get(ins.id);
    if (!trade) throw new EscrowError('E_VERSION', `revoke references unknown trade ${ins.id}`);
    if (trade.date !== ins.date) {
      throw new EscrowError('E_VERSION', `revoke of ${ins.id} dated ${ins.date} outside trade date scope ${trade.date}`);
    }
    const oldEff = effectiveOf(trade);
    trade.tombstones.add(ins.version);
    const newEff = effectiveOf(trade);
    this.applyDelta(oldEff, newEff, ledger);
  }

  // New versions never rewrite history: only the delta between the old and
  // new effective records is applied to the freeze ledger.
  applyDelta(oldRec, newRec, ledger) {
    if (oldRec && newRec && oldRec.hash === newRec.hash) return;
    if (oldRec) this.applyContribution(oldRec, -1, ledger);
    if (newRec) this.applyContribution(newRec, +1, ledger);
  }

  applyContribution(rec, sign, ledger) {
    const key = `${rec.date}|${rec.isin}`;
    const e = ledger.get(key) || zeroEntry();
    const gross = rec.qty * rec.price;
    if (rec.side === 'buy') {
      e.bought += sign * rec.qty;
      const cost = rec.priceKind === 'net' ? gross + rec.fee : gross;
      e.frozenCash = round6(e.frozenCash + sign * cost);
    } else {
      e.sold += sign * rec.qty;
      e.frozenShares += sign * rec.qty;
      const proceeds = rec.priceKind === 'net' ? gross - rec.fee : gross;
      e.proceeds = round6(e.proceeds + sign * proceeds);
    }
    ledger.set(key, e);
    this._touched.add(key);
  }

  snapshot() {
    const ledger = {};
    for (const key of [...this.ledger.keys()].sort()) {
      const e = this.ledger.get(key);
      if (isZeroEntry(e)) continue;
      ledger[key] = normalizeEntry(e);
    }
    
    const trades = {};
    for (const id of [...this.trades.keys()].sort()) {
      const t = this.trades.get(id);
      const eff = effectiveOf(t);
      trades[id] = {
        date: t.date,
        effective: eff ? { version: eff.version, hash: eff.hash } : null,
        versions: [...t.versions.keys()].sort((a, b) => a - b),
        tombstoned: [...t.tombstones].sort((a, b) => a - b),
      };
    }
    return { seq: this.lastSeq, ledger, trades };
  }
}
