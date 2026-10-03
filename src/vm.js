import { Fraction } from './fraction.js';
import { CaError } from './errors.js';
import { isValidDate } from './types.js';

const ZERO = () => new Fraction(0n);

// Settlement VM: executes bytecode against lot books and a cash account.
// State is isolated per security (each action touches exactly one book).
// Reversals append inverse corporate actions to the journal; history is
// never deleted. Sold lots are traced back FIFO; any shortfall books a
// receivable/payable instead of driving a position negative.
export class VM {
  constructor(input = {}) {
    this.lots = [];
    this.seq = 0;
    for (const l of input.lots ?? []) this.addLot(l);
    this.cash = input.cash != null ? Fraction.of(String(input.cash)) : ZERO();
    this.receivables = [];
    this.journal = [];
    this.records = new Map(); // action id -> { def, status, effects, cashDelta, reversals }
  }

  addLot(l) {
    if (!l || typeof l.security !== 'string' || !l.security) {
      throw new CaError('E_LOT', 'lot missing security');
    }
    let qty;
    try {
      qty = Fraction.of(String(l.qty));
    } catch {
      throw new CaError('E_LOT', `lot '${l.id ?? '?'}': invalid qty '${l.qty}'`);
    }
    if (qty.sign() <= 0) throw new CaError('E_LOT', `lot '${l.id ?? '?'}': qty must be positive`);
    if (typeof l.date !== 'string' || !isValidDate(l.date)) {
      throw new CaError('E_DATE', `lot '${l.id ?? '?'}': invalid date '${l.date}'`);
    }
    this.lots.push({ id: l.id ?? `L${this.seq + 1}`, security: l.security, qty, acquired: l.date, seq: this.seq++ });
  }

  run(instructions) {
    for (const ins of instructions) {
      switch (ins.op) {
        case 'APPLY':
          this.applyAction(ins.action);
          break;
        case 'REVERSE':
          this.reverseAction(ins.id);
          break;
        case 'RESTATE':
          this.restateAction(ins.id, ins.action);
          break;
        case 'SELL':
          this.sell(ins.security, ins.qty, ins.date);
          break;
        default:
          throw new CaError('E_PARSE', `unknown opcode '${ins.op}'`);
      }
    }
    return this;
  }

  book(security) {
    return this.lots.filter((l) => l.security === security).sort((a, b) => a.seq - b.seq);
  }

  eligibleLots(def) {
    return this.book(def.security).filter((l) => l.acquired < def.exdate && l.qty.sign() > 0);
  }

  applyAction(def) {
    const rec = this.records.get(def.id);
    if (rec && rec.status === 'applied') throw new CaError('E_REVERSE', `action '${def.id}' already applied`);
    const ratio = def.ratio ? Fraction.parse(def.ratio) : null;
    const cashPer = def.cash ? Fraction.parse(def.cash) : null;
    const cil = def.cashinlieu ? Fraction.parse(def.cashinlieu) : null;
    const effects = [];
    let cashDelta = ZERO();

    if (def.kind === 'split') {
      for (const lot of this.eligibleLots(def)) {
        const newQty = lot.qty.div(ratio);
        let granted;
        if (cil) {
          const intPart = newQty.floor();
          const fracPart = newQty.sub(intPart);
          cashDelta = cashDelta.add(fracPart.mul(cil));
          granted = intPart.sub(lot.qty);
          lot.qty = intPart;
        } else {
          granted = newQty.sub(lot.qty);
          lot.qty = newQty;
        }
        effects.push({ lotId: lot.id, granted: granted.toString() });
      }
    } else if (def.kind === 'dividend') {
      for (const lot of this.eligibleLots(def)) cashDelta = cashDelta.add(lot.qty.mul(cashPer));
    } else if (def.kind === 'tender') {
      for (const lot of this.eligibleLots(def)) {
        cashDelta = cashDelta.add(lot.qty.mul(cashPer));
        effects.push({ lotId: lot.id, tendered: lot.qty.toString() });
        lot.qty = ZERO();
      }
    } else {
      throw new CaError('E_ACTION', `unknown action kind '${def.kind}'`);
    }

    this.cash = this.cash.add(cashDelta);
    this.records.set(def.id, { def, status: 'applied', effects, cashDelta: cashDelta.toString(), reversals: 0 });
    this.journal.push({
      type: 'APPLY', id: def.id, kind: def.kind, security: def.security,
      version: def.version, exdate: def.exdate, hash: def.hash.slice(0, 8),
      cashDelta: cashDelta.toString(),
    });
  }

  reverseAction(id) {
    const rec = this.records.get(id);
    if (!rec) throw new CaError('E_REVERSE', `cannot reverse unknown action '${id}'`);
    if (rec.status !== 'applied') throw new CaError('E_REVERSE', `cannot reverse action '${id}' in state '${rec.status}'`);
    const def = rec.def;
    rec.reversals += 1;
    const inverseId = `${id}#rev${rec.reversals}`;
    this.journal.push({
      type: 'REVERSE', id: inverseId, reverseOf: id, kind: def.kind, security: def.security,
      version: def.version, cashDelta: Fraction.parse(rec.cashDelta).neg().toString(),
    });

    if (def.kind === 'split') {
      // Trace affected lots back in FIFO order; shortfall becomes a payable.
      for (const eff of rec.effects) {
        const lot = this.lots.find((l) => l.id === eff.lotId);
        const granted = Fraction.parse(eff.granted);
        if (granted.sign() <= 0) continue;
        const take = lot.qty.cmp(granted) >= 0 ? granted : lot.qty;
        lot.qty = lot.qty.sub(take);
        const short = granted.sub(take);
        if (short.sign() > 0) {
          const qty = short.neg().toString();
          this.receivables.push({ security: def.security, qty, reason: `reverse of ${id}`, lotId: lot.id });
          this.journal.push({ type: 'RECEIVABLE', security: def.security, qty, reason: `reverse of ${id}` });
        }
      }
    } else if (def.kind === 'tender') {
      for (const eff of rec.effects) {
        const lot = this.lots.find((l) => l.id === eff.lotId);
        lot.qty = lot.qty.add(Fraction.parse(eff.tendered));
      }
    }
    this.cash = this.cash.sub(Fraction.parse(rec.cashDelta));
    rec.status = 'reversed';
  }

  restateAction(id, def) {
    const rec = this.records.get(id);
    if (!rec) throw new CaError('E_REVERSE', `cannot restate unknown action '${id}'`);
    const fromVersion = rec.def.version;
    if (rec.status === 'applied') {
      this.reverseAction(id);
    } else if (rec.status !== 'reversed') {
      throw new CaError('E_REVERSE', `cannot restate action '${id}' in state '${rec.status}'`);
    }
    this.journal.push({ type: 'RESTATED', id, security: def.security, fromVersion, toVersion: def.version });
    this.applyAction(def);
  }

  sell(security, qtyStr, date) {
    const qty = Fraction.parse(qtyStr);
    const book = this.book(security).filter((l) => l.qty.sign() > 0);
    const total = book.reduce((a, l) => a.add(l.qty), ZERO());
    if (total.cmp(qty) < 0) {
      throw new CaError('E_LOT', `insufficient ${security} lots: need ${qty}, have ${total}`);
    }
    let remaining = qty;
    const allocations = [];
    for (const lot of book) {
      if (remaining.sign() <= 0) break;
      const take = lot.qty.cmp(remaining) <= 0 ? lot.qty : remaining;
      lot.qty = lot.qty.sub(take);
      remaining = remaining.sub(take);
      allocations.push({ lotId: lot.id, qty: take.toString() });
    }
    this.journal.push({ type: 'SELL', security, qty: qty.toString(), date, allocations });
  }

  positions() {
    return this.lots.filter((l) => l.qty.sign() > 0).sort((a, b) => a.seq - b.seq);
  }
}
