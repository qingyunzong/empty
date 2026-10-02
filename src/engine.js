import { Frac } from './fraction.js';
import { LedgerError, parseLine } from './events.js';
import { canonical, leafDigest, historyHashOf } from './canonical.js';
import { computePotentials } from './rates.js';
import { bankersRound, formatDecimal } from './rounding.js';

const KEY_SEP = '\u0001';

function slotCanonical(slot) {
  const base =
    slot.kind === 'addInvoice'
      ? { type: 'addInvoice', eid: slot.eid, id: slot.party, ccy: slot.ccy }
      : { type: 'setRate', eid: slot.eid, pair: slot.pair };
  base.num = slot.current.num.toString();
  base.den = slot.current.den.toString();
  return canonical(base);
}

export class Ledger {
  #events = new Map();
  #slots = [];
  #positions = new Map();
  #base;
  #hashCache = null;
  #stats = { lines: 0, eventsReprocessed: 0, incrementalUpdates: 0 };

  constructor({ base = null } = {}) {
    this.#base = base;
  }

  applyLine(text, lineNo = this.#stats.lines + 1) {
    const ev = parseLine(text, lineNo);
    try {
      this.applyEvent(ev);
    } catch (e) {
      if (e instanceof LedgerError && e.line === null) e.line = lineNo;
      throw e;
    }
    this.#stats.lines += 1;
    return ev;
  }

  applyEvent(ev) {
    if (this.#events.has(ev.eid)) {
      throw new LedgerError('E_PARSE', `duplicate event id: ${ev.eid}`, ev.line ?? null);
    }
    switch (ev.type) {
      case 'addInvoice':
        this.#applySlot(ev, 'addInvoice');
        break;
      case 'setRate':
        this.#applySlot(ev, 'setRate');
        break;
      case 'correct':
        this.#applyCorrect(ev);
        break;
      case 'undo':
        this.#applyUndo(ev);
        break;
      default:
        throw new LedgerError('E_PARSE', `unknown event type: ${ev.type}`, ev.line ?? null);
    }
    this.#hashCache = null;
  }

  #applySlot(ev, kind) {
    const value = new Frac(ev.num, ev.den);
    const slot = {
      index: this.#slots.length,
      kind,
      eid: ev.eid,
      party: kind === 'addInvoice' ? ev.id : null,
      ccy: kind === 'addInvoice' ? ev.ccy : null,
      pair: kind === 'setRate' ? ev.pair : null,
      from: kind === 'setRate' ? ev.from : null,
      to: kind === 'setRate' ? ev.to : null,
      original: value,
      current: value,
      corrects: [],
      rec: null,
    };
    const rec = { eid: ev.eid, type: kind, voidCount: 0, slot };
    slot.rec = rec;
    this.#events.set(ev.eid, rec);
    this.#slots.push(slot);
    if (kind === 'addInvoice') this.#positionDelta(slot.party, slot.ccy, value);
  }

  #applyCorrect(ev) {
    let target = this.#events.get(ev.refId);
    if (!target) {
      throw new LedgerError('E_REF', `correct references unknown event: ${ev.refId}`, ev.line ?? null);
    }
    while (target.type === 'correct') target = this.#events.get(target.refId);
    if (target.type === 'undo') {
      throw new LedgerError('E_REF', `cannot correct an undo event: ${ev.refId}`, ev.line ?? null);
    }
    if (target.voidCount > 0) {
      throw new LedgerError('E_REF', `correct references voided event: ${ev.refId}`, ev.line ?? null);
    }
    const slot = target.slot;
    const value = new Frac(ev.newNum, ev.newDen);
    if (slot.kind === 'setRate' && value.sign() <= 0) {
      throw new LedgerError('E_PARSE', 'corrected exchange rate must be positive', ev.line ?? null);
    }
    const rec = { eid: ev.eid, type: 'correct', voidCount: 0, refId: slot.eid, value, slot };
    this.#events.set(ev.eid, rec);
    slot.corrects.push(rec);
    this.#refreshSlot(slot);
  }

  #applyUndo(ev) {
    const target = this.#events.get(ev.eventId);
    if (!target) {
      throw new LedgerError('E_REF', `undo references unknown event: ${ev.eventId}`, ev.line ?? null);
    }
    const rec = { eid: ev.eid, type: 'undo', voidCount: 0, target: ev.eventId };
    this.#events.set(ev.eid, rec);
    target.voidCount += 1;
    if (target.voidCount === 1) this.#deactivate(target);
  }

  #deactivate(rec) {
    if (rec.type === 'addInvoice') {
      this.#positionDelta(rec.slot.party, rec.slot.ccy, rec.slot.current.neg());
    } else if (rec.type === 'correct') {
      this.#refreshSlot(rec.slot);
    } else if (rec.type === 'undo') {
      const t = this.#events.get(rec.target);
      t.voidCount -= 1;
      if (t.voidCount === 0) this.#activate(t);
    }
  }

  #activate(rec) {
    if (rec.type === 'addInvoice') {
      this.#positionDelta(rec.slot.party, rec.slot.ccy, rec.slot.current);
    } else if (rec.type === 'correct') {
      this.#refreshSlot(rec.slot);
    } else if (rec.type === 'undo') {
      const t = this.#events.get(rec.target);
      t.voidCount += 1;
      if (t.voidCount === 1) this.#deactivate(t);
    }
  }

  #refreshSlot(slot) {
    let value = slot.original;
    for (const c of slot.corrects) {
      if (c.voidCount === 0) value = c.value;
    }
    if (value.eq(slot.current)) return;
    const delta = value.sub(slot.current);
    slot.current = value;
    if (slot.kind === 'addInvoice' && slot.rec.voidCount === 0) {
      this.#positionDelta(slot.party, slot.ccy, delta);
    }
  }

  #positionDelta(party, ccy, delta) {
    const key = party + KEY_SEP + ccy;
    const cur = this.#positions.get(key) ?? Frac.zero();
    this.#positions.set(key, cur.add(delta));
    this.#stats.incrementalUpdates += 1;
  }

  getEvent(eid) {
    return this.#events.get(eid);
  }

  isActive(eid) {
    const rec = this.#events.get(eid);
    return !!rec && rec.voidCount === 0;
  }

  #defaultBase() {
    for (const slot of this.#slots) {
      if (slot.kind === 'setRate' && slot.rec.voidCount === 0) return slot.to;
    }
    const ccys = new Set();
    for (const [key, amt] of this.#positions) {
      if (!amt.isZero()) ccys.add(key.split(KEY_SEP)[1]);
    }
    return ccys.size === 1 ? [...ccys][0] : null;
  }

  historyHash() {
    if (this.#hashCache !== null) return this.#hashCache;
    const digests = [];
    for (const slot of this.#slots) {
      if (slot.rec.voidCount === 0) digests.push(leafDigest(slotCanonical(slot)));
    }
    this.#hashCache = historyHashOf(digests);
    return this.#hashCache;
  }

  stats() {
    return {
      ...this.#stats,
      events: this.#events.size,
      slots: this.#slots.length,
      activeSlots: this.#slots.filter((s) => s.rec.voidCount === 0).length,
    };
  }

  settle({ base = null, scale = 2 } = {}) {
    const baseCcy = base ?? this.#base ?? this.#defaultBase();
    const stats = this.stats();
    const hash = this.historyHash();
    const edges = this.#slots
      .filter((s) => s.kind === 'setRate' && s.rec.voidCount === 0)
      .map((s) => ({ eid: s.eid, from: s.from, to: s.to, rate: s.current }));

    if (baseCcy === null) {
      const missing = [...new Set([...this.#positions.entries()]
        .filter(([, a]) => !a.isZero())
        .map(([k]) => k.split(KEY_SEP)[1]))].sort();
      return {
        status: 'pending',
        error: { code: 'E_PENDING', message: 'no base currency could be determined', missing },
        historyHash: hash,
        stats,
      };
    }

    const { potentials, reachable, conflict } = computePotentials(baseCcy, edges);
    if (conflict) {
      return {
        status: 'infeasible',
        base: baseCcy,
        certificate: {
          type: 'RATE_CYCLE_CONFLICT',
          base: baseCcy,
          nodes: conflict.nodes,
          steps: conflict.steps.map((s) => ({
            eventId: s.eventId,
            pair: s.pair,
            direction: s.direction,
            rate: s.rate.toString(),
          })),
          product: conflict.product.toString(),
          historyHash: hash,
        },
        historyHash: hash,
        stats,
      };
    }

    const missing = new Set();
    for (const [key, amt] of this.#positions) {
      if (amt.isZero()) continue;
      const ccy = key.split(KEY_SEP)[1];
      if (!reachable.has(ccy)) missing.add(ccy);
    }
    if (missing.size > 0) {
      return {
        status: 'pending',
        base: baseCcy,
        error: {
          code: 'E_PENDING',
          message: `missing exchange rate path to ${baseCcy} for: ${[...missing].sort().join(', ')}`,
          missing: [...missing].sort(),
        },
        historyHash: hash,
        stats,
      };
    }

    const netByParty = new Map();
    for (const [key, amt] of this.#positions) {
      if (amt.isZero()) continue;
      const [party, ccy] = key.split(KEY_SEP);
      const value = amt.mul(potentials.get(ccy));
      netByParty.set(party, (netByParty.get(party) ?? Frac.zero()).add(value));
    }
    const parties = [...netByParty.keys()].sort();
    let total = Frac.zero();
    const nets = parties.map((party) => {
      const exact = netByParty.get(party);
      total = total.add(exact);
      const { rounded, error, bound } = bankersRound(exact, scale);
      return {
        party,
        exact: exact.toString(),
        posted: formatDecimal(rounded, scale),
        rounded: rounded.toString(),
        roundingError: error.toString(),
        roundingBound: bound.toString(),
      };
    });

    return {
      status: 'ok',
      base: baseCcy,
      scale,
      nets,
      total: total.toString(),
      balanced: total.isZero(),
      settlement: buildTransfers(netByParty),
      historyHash: hash,
      stats,
    };
  }
}

function buildTransfers(netByParty) {
  const debtors = [];
  const creditors = [];
  for (const [party, net] of [...netByParty.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (net.sign() < 0) debtors.push({ party, left: net.neg() });
    else if (net.sign() > 0) creditors.push({ party, left: net });
  }
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amt = d.left.cmp(c.left) <= 0 ? d.left : c.left;
    transfers.push({ from: d.party, to: c.party, amount: amt.toString() });
    d.left = d.left.sub(amt);
    c.left = c.left.sub(amt);
    if (d.left.isZero()) i += 1;
    if (c.left.isZero()) j += 1;
  }
  return {
    transfers,
    transferCount: transfers.length,
    note: 'net settlement plan; at most n-1 transfers for n non-zero parties',
  };
}
