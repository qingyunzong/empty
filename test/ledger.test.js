'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Ledger, LedgerError, canonical, hashEvent } = require('../lib/ledger');

// ---------- Independent reference implementation (used only by tests) ----------
// Causality is derived from predecessor-hash reachability, NOT vector clocks,
// so it cross-checks the library's clock-based reasoning.

function refReachability(events) {
  const byHash = new Map(events.map((e) => [e.hash, e]));
  const before = events.map(() => events.map(() => false));
  const index = new Map(events.map((e, i) => [e.hash, i]));
  for (let i = 0; i < events.length; i++) {
    const stack = [...events[i].preds];
    const seen = new Set();
    while (stack.length > 0) {
      const h = stack.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      const j = index.get(h);
      if (j === undefined) throw new Error('reference: unknown pred');
      before[j][i] = true;
      for (const p of events[j].preds) stack.push(p);
    }
  }
  return before;
}

function refAnalyze(events) {
  const before = refReachability(events);
  const idx = new Map(events.map((e, i) => [e.hash, i]));
  const byPayment = new Map();
  events.forEach((e, i) => {
    if (!byPayment.has(e.paymentId)) byPayment.set(e.paymentId, []);
    byPayment.get(e.paymentId).push(i);
  });
  const balances = {};
  const conflicts = [];
  for (const [paymentId, list] of byPayment) {
    let conflict = false;
    for (let a = 0; a < list.length && !conflict; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        if (events[i].amount !== events[j].amount && !before[i][j] && !before[j][i]) {
          conflict = true;
          break;
        }
      }
    }
    if (conflict) {
      conflicts.push(paymentId);
      continue;
    }
    const maximals = list.filter((i) => !list.some((j) => before[i][j]));
    balances[paymentId] = events[maximals[0]].amount;
  }
  const referenced = new Set(events.flatMap((e) => e.preds));
  const frontier = events.map((e) => e.hash).filter((h) => !referenced.has(h)).sort();
  const entriesHash = crypto
    .createHash('sha256')
    .update(canonical(events.map((e) => e.hash).sort()))
    .digest('hex');
  return { balances, conflicts: conflicts.sort(), frontier, entriesHash };
}

// ---------- Poset construction helpers ----------

function topoOrder(n, edges) {
  const indeg = Array(n).fill(0);
  for (const [, j] of edges) indeg[j]++;
  const queue = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  const order = [];
  while (queue.length > 0) {
    const i = queue.shift();
    order.push(i);
    for (const [a, b] of edges) if (a === i && --indeg[b] === 0) queue.push(b);
  }
  return order.length === n ? order : null; // null => cycle
}

function transitiveClosure(n, edges) {
  const order = topoOrder(n, edges);
  assert.ok(order, 'poset must be acyclic');
  const reach = Array.from({ length: n }, () => Array(n).fill(false));
  for (const i of order) {
    for (const [a, b] of edges) {
      if (b === i) {
        reach[a][i] = true;
        for (let k = 0; k < n; k++) if (reach[k][a]) reach[k][i] = true;
      }
    }
  }
  return reach;
}

// specs: [{replica, type, paymentId, amount}], edges: [[i,j]] meaning i < j
function buildPosetEvents(specs, edges) {
  const n = specs.length;
  const reach = transitiveClosure(n, edges);
  const directPreds = specs.map(() => []);
  for (const [i, j] of edges) {
    let direct = true;
    for (let k = 0; k < n; k++) {
      if (k !== i && k !== j && reach[i][k] && reach[k][j]) {
        direct = false;
        break;
      }
    }
    if (direct) directPreds[j].push(i);
  }
  const events = new Array(n);
  for (const i of topoOrder(n, edges)) {
    const clock = {};
    for (const p of directPreds[i]) {
      for (const [k, v] of Object.entries(events[p].clock)) {
        clock[k] = Math.max(clock[k] || 0, v);
      }
    }
    clock[specs[i].replica] = (clock[specs[i].replica] || 0) + 1;
    const body = {
      replica: specs[i].replica,
      type: specs[i].type,
      paymentId: specs[i].paymentId,
      amount: specs[i].amount,
      clock,
      preds: directPreds[i].map((p) => events[p].hash).sort(),
    };
    events[i] = { ...body, hash: hashEvent(body) };
  }
  return { events, reach };
}

// ---------- Unit tests ----------

test('createEvent chains on frontier and increments own clock', () => {
  const ledger = new Ledger();
  const e1 = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, ledger);
  assert.equal(ledger.addEvent(e1), 'added');
  const e2 = Ledger.createEvent({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 120 }, ledger);
  assert.deepEqual(e2.preds, [e1.hash]);
  assert.deepEqual(e2.clock, { A: 2 });
  assert.equal(ledger.addEvent(e2), 'added');
  assert.equal(ledger.addEvent(e2), 'duplicate');
});

test('rejects tampered hash', () => {
  const ledger = new Ledger();
  const e = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, ledger);
  assert.throws(() => ledger.addEvent({ ...e, amount: 999 }), (err) => err.code === 'bad-hash');
});

test('unknown-predecessor is rejected', () => {
  const ledger = new Ledger();
  const e1 = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, ledger);
  ledger.addEvent(e1);
  const e2 = Ledger.createEvent({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 120 }, ledger);
  const fresh = new Ledger();
  assert.throws(() => fresh.addEvent(e2), (err) => err.code === 'unknown-predecessor');
});

test('stale-clock is rejected for per-origin regression', () => {
  const a = new Ledger();
  const e1 = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, a);
  a.addEvent(e1);
  const e2 = Ledger.createEvent({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 120 }, a);
  a.addEvent(e2);
  // A rolls back: builds a different event on top of e1 with the same A-seq as e2
  const fork = { ...e2, paymentId: 'p2', preds: [e1.hash] };
  fork.hash = hashEvent({ replica: fork.replica, type: fork.type, paymentId: fork.paymentId, amount: fork.amount, clock: fork.clock, preds: fork.preds });
  assert.throws(() => a.addEvent(fork), (err) => err.code === 'stale-clock');
});

test('stale-clock is rejected when clock regresses below a predecessor', () => {
  const ledger = new Ledger();
  const e1 = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, ledger);
  ledger.addEvent(e1);
  const body = { replica: 'B', type: 'adjust', paymentId: 'p1', amount: 110, clock: { B: 1 }, preds: [e1.hash] };
  const e2 = { ...body, hash: hashEvent(body) };
  assert.throws(() => ledger.addEvent(e2), (err) => err.code === 'stale-clock');
});

test('concurrent different amounts conflict and block certificate', () => {
  const a = new Ledger();
  const settle = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, a);
  a.addEvent(settle);
  const b = new Ledger([settle]);
  const adjA = Ledger.createEvent({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 150 }, a);
  const adjB = Ledger.createEvent({ replica: 'B', type: 'adjust', paymentId: 'p1', amount: 200 }, b);
  a.addEvent(adjA);
  a.addEvent(adjB);
  const { conflicts } = a.analyze();
  assert.deepEqual(conflicts, ['p1']);
  assert.throws(() => a.certificate(), (err) => err.code === 'conflict');
});

test('concurrent equal amounts do not conflict', () => {
  const a = new Ledger();
  const settle = Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, a);
  a.addEvent(settle);
  const b = new Ledger([settle]);
  a.addEvent(Ledger.createEvent({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 150 }, a));
  a.addEvent(Ledger.createEvent({ replica: 'B', type: 'adjust', paymentId: 'p1', amount: 150 }, b));
  const cert = a.certificate();
  assert.equal(cert.balances.p1, 150);
});

test('causally ordered adjustments resolve in order', () => {
  const a = new Ledger();
  a.addEvent(Ledger.createEvent({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 }, a));
  const b = new Ledger(a.toJSON().events);
  b.addEvent(Ledger.createEvent({ replica: 'B', type: 'adjust', paymentId: 'p1', amount: 160 }, b));
  a.addEvent(b.toJSON().events[1]);
  a.addEvent(Ledger.createEvent({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 180 }, a));
  assert.equal(a.certificate().balances.p1, 180);
});

// ---------- Exhaustive enumeration: 2 replicas, 3 messages, all partial orders ----------

// Three messages: m0 (origin X), m1 (origin Y), m2 (origin X). Same-origin
// messages are totally ordered, so m0 < m2 always. The free message m1 may
// relate to m0 and to m2 as before / concurrent / after, giving 3x3 = 9
// combinations; the one that creates a cycle (m1 < m0 and m2 < m1) is invalid,
// leaving 8 partial orders per origin assignment. We run both (X,Y)=(A,B) and
// (X,Y)=(B,A), and two amount variants (all-distinct, and m1==m2 amounts).

function enumeratePosets(originX, originY, amounts) {
  const specs = [
    { replica: originX, type: 'settle', paymentId: 'pay', amount: amounts[0] },
    { replica: originY, type: 'adjust', paymentId: 'pay', amount: amounts[1] },
    { replica: originX, type: 'adjust', paymentId: 'pay', amount: amounts[2] },
  ];
  const results = [];
  // rel: -1 => m1 < mi, 0 => concurrent, 1 => mi < m1
  for (const rel10 of [-1, 0, 1]) {
    for (const rel12 of [-1, 0, 1]) {
      const edges = [[0, 2]]; // same-origin total order
      if (rel10 === -1) edges.push([1, 0]);
      if (rel10 === 1) edges.push([0, 1]);
      if (rel12 === -1) edges.push([1, 2]);
      if (rel12 === 1) edges.push([2, 1]);
      if (topoOrder(3, edges) === null) continue; // cycle: not a valid poset
      results.push({ specs, edges, label: `rel(m1,m0)=${rel10},rel(m1,m2)=${rel12}` });
    }
  }
  return results;
}

test('exhaustive: all partial orders of 3 messages on 2 replicas match reference', () => {
  const amountVariants = [
    [100, 200, 300], // all distinct: any concurrency conflicts
    [100, 200, 200], // m1 and m2 agree: their concurrency is not a conflict
  ];
  let cases = 0;
  for (const [originX, originY] of [['A', 'B'], ['B', 'A']]) {
    for (const amounts of amountVariants) {
      const posets = enumeratePosets(originX, originY, amounts);
      assert.equal(posets.length, 8, 'expected 8 valid partial orders');
      for (const { specs, edges, label } of posets) {
        cases++;
        const { events, reach } = buildPosetEvents(specs, edges);
        const order = topoOrder(3, edges);
        assert.ok(order);
        const ledger = new Ledger();
        for (const i of order) ledger.addEvent(events[i]);

        const context = `${originX}${originY} amounts=${amounts} ${label}`;

        // 1) causality: vector-clock order must equal pred-chain reachability
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            const { happensBefore } = require('../lib/ledger');
            assert.equal(
              happensBefore(events[i], events[j]),
              reach[i][j],
              `causality mismatch ${context} i=${i} j=${j}`
            );
          }
        }

        // 2) conflicts and balances match the independent reference
        const ref = refAnalyze(events);
        const got = ledger.analyze();
        assert.deepEqual(got.conflicts, ref.conflicts, `conflicts ${context}`);
        assert.deepEqual(got.balances, ref.balances, `balances ${context}`);

        // 3) certificate (or its refusal) matches the reference
        if (ref.conflicts.length > 0) {
          assert.throws(() => ledger.certificate(), (err) => err.code === 'conflict', context);
        } else {
          const cert = ledger.certificate();
          assert.deepEqual(cert.frontier, ref.frontier, `frontier ${context}`);
          assert.equal(cert.entriesHash, ref.entriesHash, `entriesHash ${context}`);
          assert.deepEqual(cert.balances, ref.balances, `cert balances ${context}`);
        }
      }
    }
  }
  assert.equal(cases, 32, '2 origin assignments x 2 amount variants x 8 posets');
});

test('merge accepts events in any order via multiple passes', () => {
  const specs = [
    { replica: 'A', type: 'settle', paymentId: 'pay', amount: 100 },
    { replica: 'B', type: 'adjust', paymentId: 'pay', amount: 200 },
    { replica: 'A', type: 'adjust', paymentId: 'pay', amount: 300 },
  ];
  const { events } = buildPosetEvents(specs, [[0, 1], [1, 2]]);
  const ledger = new Ledger();
  // simulate CLI multi-pass merge with reversed input
  const pending = [...events].reverse();
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      try {
        ledger.addEvent(pending[i]);
        pending.splice(i, 1);
        i--;
        progress = true;
      } catch (err) {
        if (err instanceof LedgerError && err.code === 'unknown-predecessor') continue;
        throw err;
      }
    }
  }
  assert.equal(pending.length, 0);
  assert.equal(ledger.certificate().balances.pay, 300);
});
