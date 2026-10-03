import { CorpError, E_LOT, E_DATE, E_REVERSE } from './errors.js';
import { isValidDate } from './parser.js';

const EPS = 1e-9;
export const roundShares = (x) => Math.round(x * 1e6) / 1e6;
export const roundCash = (x) => Math.round(x * 1e2) / 1e2;

function cmpDate(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The VM keeps per-security lot scopes and one shared cash account.
// It is event-driven: ops are scheduled by ex-date, then announcement
// version, then content hash (tie-break), then source order.
export class VM {
  constructor(input = {}) {
    this.lots = [];
    this.cash = 0;
    this.ledger = [];
    this.adjustments = [];
    this.actions = new Map();
    this.seq = 0;
    this.lotSeq = 0;
    if (Array.isArray(input)) input = { lots: input };
    this.cash = roundCash(input.cash ?? 0);
    for (const raw of input.lots ?? []) this.addLot(raw);
  }

  addLot(raw) {
    if (!raw || typeof raw.security !== 'string' || raw.security.length === 0) {
      throw new CorpError(E_LOT, `lot is missing a security symbol: ${JSON.stringify(raw)}`);
    }
    if (typeof raw.quantity !== 'number' || !(raw.quantity > 0)) {
      throw new CorpError(E_LOT, `lot ${raw.id ?? '?'} has invalid quantity ${raw.quantity}`);
    }
    if (typeof raw.acquired !== 'string' || !isValidDate(raw.acquired)) {
      throw new CorpError(E_DATE, `lot ${raw.id ?? '?'} has invalid acquired date ${JSON.stringify(raw.acquired)}`);
    }
    const id = raw.id ?? `L${this.lotSeq}`;
    if (this.lots.some((l) => l.id === id)) {
      throw new CorpError(E_LOT, `duplicate lot id '${id}'`);
    }
    this.lots.push({ id, sec: raw.security, qty: roundShares(raw.quantity), acquired: raw.acquired, seq: this.lotSeq++ });
  }

  run(program) {
    // Static cross-checks that must hold regardless of event ordering.
    const defs = new Map();
    for (const op of program) {
      if (op.op !== 'APPLY') continue;
      if (defs.has(op.id)) throw new CorpError(E_REVERSE, `duplicate action id '${op.id}'`);
      defs.set(op.id, op);
    }
    for (const op of program) {
      if (op.op !== 'REVERSE' && op.op !== 'RESTATE') continue;
      const target = defs.get(op.id);
      if (target && cmpDate(op.ex, target.ex) < 0) {
        const what = op.op === 'REVERSE' ? 'reversal' : 'restatement';
        throw new CorpError(E_DATE, `${what} ex-date ${op.ex} precedes action ex-date ${target.ex}`);
      }
    }
    const events = program.map((op, i) => ({ ...op, srcSeq: i }));
    events.sort((a, b) => {
      const da = a.ex ?? a.date;
      const db = b.ex ?? b.date;
      if (da !== db) return da < db ? -1 : 1;
      const va = a.version ?? -1;
      const vb = b.version ?? -1;
      if (va !== vb) return va - vb;
      const ha = a.hash ?? '';
      const hb = b.hash ?? '';
      if (ha !== hb) return ha < hb ? -1 : 1;
      return a.srcSeq - b.srcSeq;
    });
    for (const ev of events) this.exec(ev);
    return this.state();
  }

  exec(ev) {
    switch (ev.op) {
      case 'APPLY': return this.execApply(ev);
      case 'SELL': return this.execSell(ev);
      case 'REVERSE': return this.execReverse(ev);
      case 'RESTATE': return this.execRestate(ev);
      default: throw new CorpError(E_LOT, `unknown op ${ev.op}`);
    }
  }

  // Lots eligible for an original announcement: acquired before the ex-date.
  // A restatement only touches lots acquired on/after the original ex-date.
  eligible(sec, boundary, mode) {
    return this.lots
      .filter((l) => l.sec === sec && (mode === 'post' ? cmpDate(l.acquired, boundary) >= 0 : cmpDate(l.acquired, boundary) < 0))
      .sort((a, b) => cmpDate(a.acquired, b.acquired) || a.seq - b.seq);
  }

  findLot(id) {
    return this.lots.find((l) => l.id === id);
  }

  dropEmptyLots() {
    this.lots = this.lots.filter((l) => l.qty > EPS);
  }

  pushLedger(type, ev, effect) {
    const entry = {
      seq: this.seq++,
      type,
      id: ev.id ?? null,
      sec: ev.sec ?? null,
      ex: ev.ex ?? ev.date ?? null,
      version: ev.version ?? null,
      hash: ev.hash ?? null,
      effect,
      cashAfter: this.cash,
    };
    this.ledger.push(entry);
    return entry;
  }

  payable(rec) { this.adjustments.push({ type: 'payable', ...rec }); }
  receivable(rec) { this.adjustments.push({ type: 'receivable', ...rec }); }

  applyEffect(ev, boundary, mode) {
    const { sec, kind, params } = ev;
    const elig = this.eligible(sec, boundary, mode);
    if (kind === 'split') {
      const factor = 1 / params.ratio;
      const deltas = elig.map((l) => {
        const d = { lotId: l.id, before: l.qty, after: roundShares(l.qty * factor) };
        l.qty = d.after;
        return d;
      });
      return { kind: 'split', ratio: params.ratio, boundary, mode, deltas };
    }
    if (kind === 'dividend') {
      const quantity = roundShares(elig.reduce((s, l) => s + l.qty, 0));
      const amount = roundCash(quantity * params.amount);
      this.cash = roundCash(this.cash + amount);
      return { kind: 'dividend', perShare: params.amount, quantity, amount, boundary, mode };
    }
    // tender: buy `fraction` of every eligible lot at `price`
    const deltas = [];
    let shares = 0;
    for (const l of elig) {
      const sold = roundShares(l.qty * params.fraction);
      l.qty = roundShares(l.qty - sold);
      deltas.push({ lotId: l.id, sold });
      shares += sold;
    }
    this.dropEmptyLots();
    const amount = roundCash(roundShares(shares) * params.price);
    this.cash = roundCash(this.cash + amount);
    return { kind: 'tender', price: params.price, fraction: params.fraction, boundary, mode, deltas, amount };
  }

  execApply(ev) {
    if (this.actions.has(ev.id)) {
      throw new CorpError(E_REVERSE, `duplicate action id '${ev.id}'`);
    }
    const effect = this.applyEffect(ev, ev.ex, 'pre');
    const entry = this.pushLedger('APPLY', ev, effect);
    this.actions.set(ev.id, {
      id: ev.id, sec: ev.sec, kind: ev.kind, params: ev.params,
      ex: ev.ex, version: ev.version, status: 'applied', entry,
    });
  }

  execSell(ev) {
    const available = roundShares(this.lots.filter((l) => l.sec === ev.sec).reduce((s, l) => s + l.qty, 0));
    if (ev.qty > available + EPS) {
      throw new CorpError(E_LOT, `insufficient ${ev.sec} holdings: sell ${ev.qty} but only ${available} held`);
    }
    let need = ev.qty;
    const deltas = [];
    const fifo = this.lots.filter((l) => l.sec === ev.sec).sort((a, b) => cmpDate(a.acquired, b.acquired) || a.seq - b.seq);
    for (const l of fifo) {
      if (need <= EPS) break;
      const take = Math.min(l.qty, need);
      l.qty = roundShares(l.qty - take);
      need = roundShares(need - take);
      deltas.push({ lotId: l.id, sold: take });
    }
    this.dropEmptyLots();
    this.pushLedger('SELL', ev, { kind: 'sell', qty: ev.qty, deltas });
  }

  deductCash(amount, reason) {
    if (this.cash + EPS >= amount) {
      this.cash = roundCash(this.cash - amount);
    } else {
      const short = roundCash(amount - this.cash);
      this.cash = 0;
      this.payable({ cash: short, reason });
    }
  }

  execReverse(ev) {
    const a = this.actions.get(ev.id);
    if (!a) throw new CorpError(E_REVERSE, `cannot reverse unknown action '${ev.id}'`);
    if (a.status !== 'applied') {
      throw new CorpError(E_REVERSE, `cannot reverse action '${ev.id}' in status '${a.status}'`);
    }
    if (cmpDate(ev.ex, a.ex) < 0) {
      throw new CorpError(E_DATE, `reversal ex-date ${ev.ex} precedes action ex-date ${a.ex}`);
    }
    const eff = a.entry.effect;
    const undo = { kind: eff.kind, reverses: a.id };
    if (eff.kind === 'split') {
      // Remove the shares the split added, FIFO across the recorded lots.
      // Lots already sold cannot go negative: the shortfall is a payable.
      undo.deltas = [];
      for (const d of eff.deltas) {
        const added = roundShares(d.after - d.before);
        const lot = this.findLot(d.lotId);
        if (lot) {
          const take = Math.min(lot.qty, added);
          lot.qty = roundShares(lot.qty - take);
          const short = roundShares(added - take);
          undo.deltas.push({ lotId: d.lotId, removed: take, shortfall: short });
          if (short > EPS) {
            this.payable({ sec: a.sec, shares: short, reason: `reversal of ${a.id}: lot ${d.lotId} partially sold` });
          }
        } else {
          undo.deltas.push({ lotId: d.lotId, removed: 0, shortfall: added });
          this.payable({ sec: a.sec, shares: added, reason: `reversal of ${a.id}: lot ${d.lotId} fully sold` });
        }
      }
      this.dropEmptyLots();
    } else if (eff.kind === 'dividend') {
      undo.amount = eff.amount;
      this.deductCash(eff.amount, `reversal of ${a.id}: dividend clawback exceeds cash`);
    } else if (eff.kind === 'tender') {
      undo.deltas = [];
      for (const d of eff.deltas) {
        const lot = this.findLot(d.lotId);
        if (lot) {
          lot.qty = roundShares(lot.qty + d.sold);
          undo.deltas.push({ lotId: d.lotId, restored: d.sold });
        } else {
          undo.deltas.push({ lotId: d.lotId, restored: 0, receivable: d.sold });
          this.receivable({ sec: a.sec, shares: d.sold, reason: `reversal of ${a.id}: lot ${d.lotId} no longer held` });
        }
      }
      undo.amount = eff.amount;
      this.deductCash(eff.amount, `reversal of ${a.id}: tender buyback exceeds cash`);
    }
    a.status = 'reversed';
    this.pushLedger('REVERSE', { ...ev, sec: a.sec }, undo);
  }

  execRestate(ev) {
    const a = this.actions.get(ev.id);
    if (!a) throw new CorpError(E_REVERSE, `cannot restate unknown action '${ev.id}'`);
    if (a.status !== 'applied' && a.status !== 'reversed') {
      throw new CorpError(E_REVERSE, `cannot restate action '${ev.id}' in status '${a.status}'`);
    }
    if (ev.sec !== a.sec) {
      throw new CorpError(E_REVERSE, `restated action '${ev.id}' changes security ${a.sec} -> ${ev.sec}`);
    }
    if (cmpDate(ev.ex, a.ex) < 0) {
      throw new CorpError(E_DATE, `restatement ex-date ${ev.ex} precedes action ex-date ${a.ex}`);
    }
    // A restatement only affects lots acquired on/after the original ex-date.
    const effect = this.applyEffect({ ...ev, kind: ev.kind, params: ev.params }, a.ex, 'post');
    effect.restates = a.id;
    a.status = 'restated';
    this.pushLedger('RESTATED', ev, effect);
  }

  state() {
    const positions = {};
    const lots = [...this.lots].sort((a, b) => (a.sec < b.sec ? -1 : a.sec > b.sec ? 1 : cmpDate(a.acquired, b.acquired) || a.seq - b.seq));
    for (const l of lots) {
      if (!positions[l.sec]) positions[l.sec] = { total: 0, lots: [] };
      positions[l.sec].total = roundShares(positions[l.sec].total + l.qty);
      positions[l.sec].lots.push({ id: l.id, quantity: l.qty, acquired: l.acquired });
    }
    return { positions, cash: this.cash, adjustments: this.adjustments, ledger: this.ledger };
  }
}
