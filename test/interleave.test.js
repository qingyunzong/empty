import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { prepareFrames } from '../src/runner.js';
import { frame } from '../testutil/sign.mjs';

// ---------------------------------------------------------------------------
// Independent reference matcher: a deliberately naive, separately structured
// re-implementation of the documented semantics. It shares no code with
// src/engine.js (only the frame-signing helper), and recomputes its book
// from scratch on every match round.
// ---------------------------------------------------------------------------
function referenceRun(frames, config = {}) {
  const window = config.window ?? 1000;
  const accounts = new Map();
  for (const [n, a] of Object.entries(config.accounts ?? {})) {
    accounts.set(n, { cashAvail: a.cash ?? 0, cashFrozen: 0, secAvail: a.sec ?? 0, secFrozen: 0 });
  }
  const getA = (n) => {
    if (!accounts.has(n)) accounts.set(n, { cashAvail: Infinity, cashFrozen: 0, secAvail: Infinity, secFrozen: 0 });
    return accounts.get(n);
  };
  const orders = new Map();
  const trades = [];
  let now = 0;
  let tseq = 0;
  const prio = (a, b) => a.prioTs - b.prioTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const f of frames) {
    const ts = f.ts ?? f.seq;
    if (ts > now) now = ts;
    for (const o of [...orders.values()]
      .filter((o) => o.state === 'open' && now - o.entryTs >= window)
      .sort((a, b) => a.entrySeq - b.entrySeq || (a.id < b.id ? -1 : 1))) {
      o.state = 'expired';
      o.remaining = 0;
    }
    if (f.op === 'new') {
      orders.set(f.clOrdId, {
        id: f.clOrdId, side: f.side, acct: f.acct ?? 'default', qty: f.qty, price: f.price,
        filled: 0, remaining: f.qty, entryTs: now, entrySeq: f.seq, prioTs: now, state: 'open',
      });
    } else if (f.op === 'amend') {
      const o = orders.get(f.origId);
      if (o.state !== 'open') continue;
      const q = f.qty ?? o.qty;
      const p = f.price ?? o.price;
      if (q < o.filled) continue;
      if (p !== o.price) o.prioTs = now;
      o.qty = q;
      o.price = p;
      o.remaining = q - o.filled;
      if (o.remaining === 0) o.state = 'filled';
    } else if (f.op === 'cancel') {
      const o = orders.get(f.origId);
      if (o.state !== 'open') continue;
      o.state = 'canceled';
      o.remaining = 0;
    } else if (f.op === 'match') {
      const skipB = new Set();
      const skipS = new Set();
      for (;;) {
        const bs = [...orders.values()]
          .filter((o) => o.state === 'open' && o.side === 'buy' && o.remaining > 0 && !skipB.has(o.id))
          .sort((a, b) => b.price - a.price || prio(a, b));
        const ss = [...orders.values()]
          .filter((o) => o.state === 'open' && o.side === 'sell' && o.remaining > 0 && !skipS.has(o.id))
          .sort((a, b) => a.price - b.price || prio(a, b));
        if (!bs.length || !ss.length) break;
        const b = bs[0];
        const s = ss[0];
        if (b.price < s.price) break;
        const qty = Math.min(b.remaining, s.remaining);
        const maker = prio(b, s) <= 0 ? b : s;
        const price = maker.price;
        const amount = qty * price;
        const ba = getA(b.acct);
        const sa = getA(s.acct);
        if (ba.cashAvail < amount) { skipB.add(b.id); continue; }
        if (sa.secAvail < qty) { skipS.add(s.id); continue; }
        ba.cashAvail -= amount;
        ba.cashFrozen += amount;
        sa.secAvail -= qty;
        sa.secFrozen += qty;
        trades.push({ tradeId: 'T' + ++tseq, buyId: b.id, sellId: s.id, qty, price, state: 'matched' });
        b.filled += qty;
        b.remaining -= qty;
        s.filled += qty;
        s.remaining -= qty;
        if (!b.remaining) b.state = 'filled';
        if (!s.remaining) s.state = 'filled';
      }
    }
  }
  const fin = (v) => (v === Infinity ? 'unlimited' : v);
  return {
    orders: [...orders.values()].map((o) => ({ clOrdId: o.id, side: o.side, qty: o.qty, price: o.price, filled: o.filled, remaining: o.remaining, state: o.state })),
    trades,
    accounts: [...accounts.entries()].map(([name, a]) => ({ acct: name, cashAvail: fin(a.cashAvail), cashFrozen: a.cashFrozen, secAvail: fin(a.secAvail), secFrozen: a.secFrozen })),
  };
}

// ---------------------------------------------------------------------------
// Interleaving enumeration: every legal ordering of <= 7 instructions.
// ---------------------------------------------------------------------------
function* interleavings(items, prereqs) {
  const done = new Set();
  const seq = [];
  function* rec() {
    if (seq.length === items.length) {
      yield [...seq];
      return;
    }
    for (const it of items) {
      if (done.has(it)) continue;
      const pre = prereqs[it] ?? [];
      if (pre.some((p) => !done.has(p))) continue;
      done.add(it);
      seq.push(it);
      yield* rec();
      done.delete(it);
      seq.pop();
    }
  }
  yield* rec();
}

const BUILDERS = {
  N1: (seq) => ({ op: 'new', clOrdId: 'B1', side: 'buy', qty: 100, price: 110, acct: 'A', seq, ts: seq }),
  N2: (seq) => ({ op: 'new', clOrdId: 'S1', side: 'sell', qty: 80, price: 100, acct: 'B', seq, ts: seq }),
  N3: (seq) => ({ op: 'new', clOrdId: 'S2', side: 'sell', qty: 60, price: 105, acct: 'B', seq, ts: seq }),
  A1: (seq) => ({ op: 'amend', clOrdId: 'AM1', origId: 'B1', qty: 150, seq, ts: seq }),
  A2: (seq) => ({ op: 'amend', clOrdId: 'AM2', origId: 'S1', price: 108, seq, ts: seq }),
  C1: (seq) => ({ op: 'cancel', clOrdId: 'CX1', origId: 'S2', seq, ts: seq }),
  M1: (seq) => ({ op: 'match', clOrdId: 'MM1', seq, ts: seq }),
  M2: (seq) => ({ op: 'match', clOrdId: 'MM2', seq, ts: seq }),
};

// Limited balances so some interleavings hit DvP rejections.
const CONFIG = { window: 1000, accounts: { A: { cash: 12000, sec: 0 }, B: { cash: 0, sec: 100 } } };

function engineRun(frames) {
  // Arrival order is reversed and the first frame is retransmitted to also
  // exercise reordering + dedup on every interleaving.
  const messy = [...frames, frames[0]].reverse();
  const ordered = prepareFrames(messy);
  const e = new Engine(CONFIG);
  for (const f of ordered) e.apply(f);
  return e.snapshot();
}

function normalize(snap) {
  return {
    orders: [...snap.orders].sort((a, b) => (a.clOrdId < b.clOrdId ? -1 : 1)),
    trades: snap.trades,
    accounts: [...snap.accounts].sort((a, b) => (a.acct < b.acct ? -1 : 1)),
  };
}

function checkSuite(t, keys, prereqs) {
  let count = 0;
  for (const perm of interleavings(keys, prereqs)) {
    const frames = perm.map((k, i) => frame(BUILDERS[k](i + 1)));
    const expected = normalize(referenceRun(frames, CONFIG));
    const actual = normalize(engineRun(frames));
    try {
      assert.deepStrictEqual(actual, expected);
    } catch (err) {
      t.diagnostic(`divergence at interleaving: ${perm.join(',')}`);
      throw err;
    }
    count++;
  }
  return count;
}

test('acceptance 5: all legal interleavings of 5 instructions match the reference', (t) => {
  const n = checkSuite(t, ['N1', 'N2', 'A1', 'M1', 'M2'], { A1: ['N1'] });
  t.diagnostic(`checked ${n} interleavings`);
  assert.ok(n > 0);
});

test('acceptance 5: all legal interleavings of 6 instructions match the reference', (t) => {
  const n = checkSuite(t, ['N1', 'N2', 'N3', 'C1', 'M1', 'M2'], { C1: ['N3'] });
  t.diagnostic(`checked ${n} interleavings`);
  assert.ok(n > 0);
});

test('acceptance 5: all legal interleavings of 7 instructions match the reference', (t) => {
  const n = checkSuite(t, ['N1', 'N2', 'N3', 'A1', 'A2', 'C1', 'M1', 'M2'].slice(0, 7), { A1: ['N1'], A2: ['N2'], C1: ['N3'] });
  t.diagnostic(`checked ${n} interleavings`);
  assert.ok(n > 0);
});
