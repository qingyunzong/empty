'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, r6 } = require('../src/engine');
const { Calendar } = require('../src/calendar');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Independent reference model: full recompute from scratch, no dependency graph.
class Ref {
  constructor() {
    this.cal = null;
    this.trades = new Map();
    this.comp = [];
    this.liq = new Map();
  }
  calendar(version, holidays) { this.cal = new Calendar(version, holidays); }
  trade(p) {
    this.trades.set(p.id, {
      id: p.id, payCcy: p.payCcy, payAmt: r6(p.payAmt),
      recvCcy: p.recvCcy, recvAmt: r6(p.recvAmt),
      requested: p.valueDate,
      maturity: p.maturity || `${p.valueDate}T00:00:00.000Z`,
      cancelled: false,
    });
  }
  cancel(id) {
    const t = this.trades.get(id);
    t.cancelled = true;
    this.comp.push({
      id: `COMP-${t.id}`,
      forTrade: t.id,
      pair: [t.payCcy, t.recvCcy].sort().join('/'),
      legs: [
        { ccy: t.payCcy, amount: r6(-t.payAmt) },
        { ccy: t.recvCcy, amount: r6(-t.recvAmt) },
      ],
      reason: 'CANCEL_COMPENSATION',
      valueDate: this.cal.adjust(t.requested),
    });
  }
  delay(id, valueDate) { this.trades.get(id).requested = valueDate; }
  reprice(id, rate) {
    const t = this.trades.get(id);
    t.recvAmt = r6(t.payAmt * rate);
  }
  liquidity(ccy, amount) { this.liq.set(ccy, r6(amount)); }

  compute() {
    const groups = new Map();
    for (const t of this.trades.values()) {
      if (t.cancelled) continue;
      const pair = [t.payCcy, t.recvCcy].sort().join('/');
      const key = `${pair}|${this.cal.adjust(t.requested)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const exposures = new Map();
    const add = (c, a) => {
      const v = r6((exposures.get(c) || 0) + a);
      if (v === 0) exposures.delete(c); else exposures.set(c, v);
    };
    const paired = [];
    const open = [];
    for (const members of groups.values()) {
      members.sort((a, b) => cmpStr(a.maturity, b.maturity) || cmpStr(a.id, b.id));
      const waiting = new Map();
      for (const t of members) {
        add(t.payCcy, -t.payAmt);
        add(t.recvCcy, t.recvAmt);
        t.matched = false;
        const sorted = [t.payCcy, t.recvCcy].sort();
        const other = t.payCcy === sorted[0] ? sorted[1] : sorted[0];
        const u = waiting.get(other);
        if (u) {
          waiting.delete(other);
          t.matched = true;
          u.matched = true;
          paired.push(u, t);
        } else if (!waiting.has(t.payCcy)) {
          waiting.set(t.payCcy, t);
        }
      }
      for (const t of members) if (!t.matched) open.push(t);
    }
    const items = paired.map((t) => ({
      instruction: `SI-${t.id}`,
      tradeId: t.id,
      ccy: t.payCcy,
      amount: t.payAmt,
      valueDate: this.cal.adjust(t.requested),
      maturity: t.maturity,
      status: 'DELIVERABLE',
    }));
    items.sort((a, b) =>
      cmpStr(a.valueDate, b.valueDate) || cmpStr(a.maturity, b.maturity) || cmpStr(a.tradeId, b.tradeId));
    const avail = new Map(this.liq);
    for (const it of items) {
      const a = avail.get(it.ccy) || 0;
      if (a + 1e-9 >= it.amount) avail.set(it.ccy, r6(a - it.amount));
      else { it.status = 'PENDING'; it.reason = `INSUFFICIENT_LIQUIDITY:${it.ccy}`; }
    }
    open.sort((a, b) => cmpStr(a.maturity, b.maturity) || cmpStr(a.id, b.id));
    for (const t of open) {
      items.push({
        instruction: `SI-${t.id}`,
        tradeId: t.id,
        ccy: t.payCcy,
        amount: t.payAmt,
        valueDate: this.cal.adjust(t.requested),
        maturity: t.maturity,
        status: 'PENDING',
        reason: 'UNMATCHED',
      });
    }
    return {
      items,
      exposures: [...exposures.entries()].sort(([a], [b]) => cmpStr(a, b)).map(([ccy, amount]) => ({ ccy, amount })),
    };
  }
}

const PAIRS = [['EUR', 'USD'], ['USD', 'JPY'], ['EUR', 'JPY']];
const DATES = ['2026-01-05', '2026-01-06', '2026-01-07'];
const CALS = [
  { version: 'v1', holidays: [] },
  { version: 'v2', holidays: ['2026-01-05'] },
  { version: 'v3', holidays: ['2026-01-05', '2026-01-06'] },
];

for (const seed of [1, 7, 42, 1337]) {
  test(`random small-set cross-check against reference model (seed ${seed})`, () => {
    const rnd = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const engine = new Engine();
    const ref = new Ref();
    const cal0 = CALS[0];
    engine.apply('calendar', cal0);
    ref.calendar(cal0.version, cal0.holidays);

    let counter = 0;
    const activeIds = () => [...ref.trades.values()].filter((t) => !t.cancelled).map((t) => t.id);

    for (let step = 0; step < 300; step++) {
      const roll = rnd();
      const active = activeIds();
      if (roll < 0.35 || active.length === 0) {
        const [c1, c2] = pick(PAIRS);
        const date = pick(DATES);
        const payAmt = 10 + Math.floor(rnd() * 490);
        const rate = 0.5 + rnd() * 1.5;
        const p = {
          id: `T${counter++}`,
          payCcy: c1, payAmt,
          recvCcy: c2, recvAmt: r6(payAmt * rate),
          valueDate: date,
          maturity: `${date}T${String(Math.floor(rnd() * 24)).padStart(2, '0')}:00:00.000Z`,
        };
        if (rnd() < 0.5) { [p.payCcy, p.recvCcy] = [p.recvCcy, p.payCcy]; [p.payAmt, p.recvAmt] = [p.recvAmt, p.payAmt]; }
        engine.apply('trade', p);
        ref.trade(p);
      } else if (roll < 0.5) {
        const id = pick(active);
        engine.apply('cancel', { id });
        ref.cancel(id);
      } else if (roll < 0.65) {
        const id = pick(active);
        const date = pick(DATES);
        engine.apply('delay', { id, valueDate: date });
        ref.delay(id, date);
      } else if (roll < 0.75) {
        const id = pick(active);
        const rate = 0.5 + rnd() * 1.5;
        engine.apply('reprice', { id, rate });
        ref.reprice(id, rate);
      } else if (roll < 0.85) {
        const ccy = pick(['EUR', 'USD', 'JPY']);
        const amount = Math.floor(rnd() * 1000);
        engine.apply('liquidity', { ccy, amount });
        ref.liquidity(ccy, amount);
      } else {
        const c = pick(CALS);
        engine.apply('calendar', c);
        ref.calendar(c.version, c.holidays);
      }

      const expected = ref.compute();
      const gotItems = engine.deliverables().map(({ pairId, ...rest }) => rest);
      assert.deepEqual(gotItems, expected.items, `deliverables diverge at step ${step}`);
      assert.deepEqual(engine.exposureList(), expected.exposures, `exposures diverge at step ${step}`);
      assert.deepEqual(engine.compensations, ref.comp, `compensations diverge at step ${step}`);
    }
    assert.equal(engine.proof().ok, true);
  });
}
