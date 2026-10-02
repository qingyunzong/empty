import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, LedgerError, hashEvent } from '../src/ledger.js';

// Deterministic event factory for hand-crafted DAGs.
function makeEvent(id, type, tradeId, prev, observes = null) {
  const event = { id, type, tradeId, prev: [...prev].sort(), observes };
  event.hash = hashEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// Independent set-based reference implementation.
// Computes causal past by fixpoint iteration over parent sets and derives
// tombstones/status with plain set algebra. Shares no code with the library.
// ---------------------------------------------------------------------------
function referenceModel(events) {
  const byHash = new Map(events.map((e) => [e.hash, e]));
  const past = new Map(events.map((e) => [e.hash, new Set()]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of events) {
      const acc = past.get(e.hash);
      for (const dep of [...e.prev, e.observes].filter(Boolean)) {
        if (!byHash.has(dep)) continue;
        if (!acc.has(dep)) { acc.add(dep); changed = true; }
        for (const older of past.get(dep)) {
          if (!acc.has(older)) { acc.add(older); changed = true; }
        }
      }
    }
  }
  const states = new Map();
  const tombstoneSet = new Set();
  const tradeIds = new Set(events.filter((e) => e.type === 'trade').map((e) => e.tradeId));
  for (const tradeId of tradeIds) {
    const cancels = events.filter((e) => e.type === 'cancel' && e.tradeId === tradeId);
    const restores = events.filter((e) => e.type === 'restore' && e.tradeId === tradeId);
    let conflict = false;
    let tombstone = false;
    for (const c of cancels) {
      let cleared = false;
      for (const r of restores) {
        if (past.get(r.hash).has(c.hash)) cleared = true;
        else if (!past.get(c.hash).has(r.hash)) conflict = true;
      }
      if (!cleared) tombstone = true;
    }
    if (tombstone) tombstoneSet.add(tradeId);
    states.set(tradeId, conflict ? 'conflict' : tombstone ? 'cancelled' : 'active');
  }
  return { states, tombstoneSet };
}

function assertMatchesReference(ledger, events) {
  const ref = referenceModel(events);
  for (const [tradeId, status] of ref.states) {
    assert.equal(ledger.getState(tradeId).status, status, `status of ${tradeId}`);
    assert.equal(ledger.getState(tradeId).tombstone, ref.tombstoneSet.has(tradeId));
  }
  assert.deepEqual(ledger.tombstones(), [...ref.tombstoneSet].sort());
}

// All topological orderings of an event DAG (deps = prev + observes).
function topoSorts(events) {
  const byHash = new Map(events.map((e) => [e.hash, e]));
  const deps = new Map(events.map((e) => [
    e.hash,
    [...e.prev, e.observes].filter((h) => h && byHash.has(h)),
  ]));
  const results = [];
  const placed = new Set();
  const order = [];
  function walk() {
    if (order.length === events.length) {
      results.push(order.map((h) => byHash.get(h)));
      return;
    }
    for (const e of events) {
      if (placed.has(e.hash)) continue;
      if (!deps.get(e.hash).every((d) => placed.has(d))) continue;
      placed.add(e.hash);
      order.push(e.hash);
      walk();
      order.pop();
      placed.delete(e.hash);
    }
  }
  walk();
  return results;
}

test('acceptance 1: trade -> cancel -> restore ends active', () => {
  const ledger = new Ledger();
  ledger.createTrade('T1');
  assert.equal(ledger.getState('T1').status, 'active');
  ledger.createCancel('T1');
  assert.equal(ledger.getState('T1').status, 'cancelled');
  assert.equal(ledger.getState('T1').tombstone, true);
  ledger.createRestore('T1');
  const state = ledger.getState('T1');
  assert.equal(state.status, 'active');
  assert.equal(state.tombstone, false);
  assert.deepEqual(ledger.tombstones(), []);
});

test('acceptance 2: stale replica replaying an old cancel cannot undo a restored trade', () => {
  const replicaA = new Ledger();
  replicaA.createTrade('T1');
  replicaA.createCancel('T1');
  const staleCopy = replicaA.events(); // old replica snapshot: trade + cancel
  replicaA.createRestore('T1');
  assert.equal(replicaA.getState('T1').status, 'active');

  const result = replicaA.merge(staleCopy); // delayed replay of the old cancel
  assert.equal(result.added, 0);
  assert.equal(result.duplicates, 2);
  assert.equal(replicaA.getState('T1').status, 'active');
  assert.equal(replicaA.getState('T1').tombstone, false);
});

test('acceptance 3a: restore without observing a cancel is rejected', () => {
  const ledger = new Ledger();
  ledger.createTrade('T1');
  assert.throws(() => ledger.createRestore('T1'), (err) => {
    assert.ok(err instanceof LedgerError);
    assert.equal(err.code, 'restore-without-cancel');
    return true;
  });
  // A forged restore event that observes nothing real is rejected on merge.
  const trade = ledger.events()[0];
  const forged = makeEvent('r-forged', 'restore', 'T1', [trade.hash], '0'.repeat(64));
  assert.throws(() => ledger.merge([forged]), (err) => {
    assert.equal(err.code, 'restore-without-cancel');
    return true;
  });
  assert.equal(ledger.getState('T1').status, 'active'); // failed merge is atomic
});

test('acceptance 3b: concurrent cancel and restore is a conflict', () => {
  const trade = makeEvent('e1', 'trade', 'T1', []);
  const cancel1 = makeEvent('e2', 'cancel', 'T1', [trade.hash], trade.hash);
  // restore and cancel2 both sit on top of cancel1 without observing each other
  const restore = makeEvent('e3', 'restore', 'T1', [cancel1.hash], cancel1.hash);
  const cancel2 = makeEvent('e4', 'cancel', 'T1', [cancel1.hash], trade.hash);
  const events = [trade, cancel1, restore, cancel2];
  const ledger = new Ledger(events);
  assert.equal(ledger.getState('T1').status, 'conflict');
  assertMatchesReference(ledger, events);
});

test('concurrent cancels of one trade keep a single tombstone', () => {
  const trade = makeEvent('e1', 'trade', 'T1', []);
  const cancel1 = makeEvent('e2', 'cancel', 'T1', [trade.hash], trade.hash);
  const cancel2 = makeEvent('e3', 'cancel', 'T1', [trade.hash], trade.hash);
  const events = [trade, cancel1, cancel2];
  const ledger = new Ledger(events);
  const state = ledger.getState('T1');
  assert.equal(state.status, 'cancelled');
  assert.equal(state.tombstone, true); // one logical tombstone despite two cancels
  assert.deepEqual(ledger.tombstones(), ['T1']);
  assertMatchesReference(ledger, events);
});

test('duplicate events are idempotent', () => {
  const ledger = new Ledger();
  ledger.createTrade('T1');
  ledger.createCancel('T1');
  const snapshot = ledger.events();
  const again = ledger.merge(snapshot);
  assert.deepEqual(again, { added: 0, duplicates: 2 });
  assert.equal(ledger.size, 2);
  assert.equal(ledger.getState('T1').status, 'cancelled');
});

test('restore causally after concurrent cancels clears both', () => {
  const trade = makeEvent('e1', 'trade', 'T1', []);
  const cancel1 = makeEvent('e2', 'cancel', 'T1', [trade.hash], trade.hash);
  const cancel2 = makeEvent('e3', 'cancel', 'T1', [trade.hash], trade.hash);
  const restore = makeEvent('e4', 'restore', 'T1', [cancel1.hash, cancel2.hash], cancel1.hash);
  const events = [trade, cancel1, cancel2, restore];
  const ledger = new Ledger(events);
  assert.equal(ledger.getState('T1').status, 'active');
  assertMatchesReference(ledger, events);
});

test('cancel issued after a restore re-cancels without conflict', () => {
  const trade = makeEvent('e1', 'trade', 'T1', []);
  const cancel1 = makeEvent('e2', 'cancel', 'T1', [trade.hash], trade.hash);
  const restore = makeEvent('e3', 'restore', 'T1', [cancel1.hash], cancel1.hash);
  const cancel2 = makeEvent('e4', 'cancel', 'T1', [restore.hash], trade.hash);
  const events = [trade, cancel1, restore, cancel2];
  const ledger = new Ledger(events);
  const state = ledger.getState('T1');
  assert.equal(state.status, 'cancelled');
  assert.equal(state.tombstone, true);
  assertMatchesReference(ledger, events);
});

test('all topological orders of trade/cancel/restore DAGs converge to the reference model', () => {
  const scenarios = [];

  // Chain T1->C1->R1 plus an independent trade T2: 4 topological orders.
  {
    const t1 = makeEvent('a1', 'trade', 'T1', []);
    const c1 = makeEvent('a2', 'cancel', 'T1', [t1.hash], t1.hash);
    const r1 = makeEvent('a3', 'restore', 'T1', [c1.hash], c1.hash);
    const t2 = makeEvent('a4', 'trade', 'T2', []);
    scenarios.push(['chain+independent', [t1, c1, r1, t2]]);
  }

  // Concurrent cancels C1,C2, restore observing both: 2 topological orders.
  {
    const t1 = makeEvent('b1', 'trade', 'T1', []);
    const c1 = makeEvent('b2', 'cancel', 'T1', [t1.hash], t1.hash);
    const c2 = makeEvent('b3', 'cancel', 'T1', [t1.hash], t1.hash);
    const r1 = makeEvent('b4', 'restore', 'T1', [c1.hash, c2.hash], c1.hash);
    scenarios.push(['concurrent-cancels', [t1, c1, c2, r1]]);
  }

  // Two independent trades each with cancel+restore chains: interleavings.
  {
    const t1 = makeEvent('c1', 'trade', 'T1', []);
    const c1 = makeEvent('c2', 'cancel', 'T1', [t1.hash], t1.hash);
    const r1 = makeEvent('c3', 'restore', 'T1', [c1.hash], c1.hash);
    const t2 = makeEvent('c4', 'trade', 'T2', []);
    const c2 = makeEvent('c5', 'cancel', 'T2', [t2.hash], t2.hash);
    scenarios.push(['two-chains', [t1, c1, r1, t2, c2]]);
  }

  for (const [name, events] of scenarios) {
    const orders = topoSorts(events);
    assert.ok(orders.length > 1, `${name}: expected multiple topological orders`);
    const expected = referenceModel(events);
    const seen = [];
    for (const order of orders) {
      const ledger = new Ledger();
      ledger.merge(order); // batch merge tolerates any causal order
      assertMatchesReference(ledger, events);
      seen.push(JSON.stringify([...expected.states].map(([id]) => ledger.getState(id).status)));
    }
    assert.equal(new Set(seen).size, 1, `${name}: all orders converge`);
    // One-by-one insertion in causal order converges too.
    const incremental = new Ledger();
    for (const event of orders[0]) incremental.add(event);
    assertMatchesReference(incremental, events);
  }
});

test('every permutation of a linear trade/cancel/restore chain converges', () => {
  const t1 = makeEvent('p1', 'trade', 'T1', []);
  const c1 = makeEvent('p2', 'cancel', 'T1', [t1.hash], t1.hash);
  const r1 = makeEvent('p3', 'restore', 'T1', [c1.hash], c1.hash);
  const events = [t1, c1, r1];
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ].map((perm) => perm.map((i) => events[i]));
  for (const perm of permutations) {
    const ledger = new Ledger();
    ledger.merge(perm);
    assert.equal(ledger.getState('T1').status, 'active');
    assertMatchesReference(ledger, events);
  }
});

test('merge validation errors', () => {
  const ledger = new Ledger();
  ledger.createTrade('T1');
  const trade = ledger.events()[0];

  // cancel observing an unknown trade hash
  const badCancel = makeEvent('x1', 'cancel', 'T1', [trade.hash], 'f'.repeat(64));
  assert.throws(() => ledger.merge([badCancel]), (err) => {
    assert.equal(err.code, 'unknown-trade');
    return true;
  });

  // cancel on a trade that does not exist at all
  const ghostTrade = makeEvent('x2', 'trade', 'GHOST', []);
  const ghostCancel = makeEvent('x3', 'cancel', 'NOPE', [ghostTrade.hash], ghostTrade.hash);
  assert.throws(() => ledger.merge([ghostTrade, ghostCancel]), (err) => {
    assert.equal(err.code, 'unknown-trade');
    return true;
  });

  // tampered hash
  const tampered = { ...makeEvent('x4', 'cancel', 'T1', [trade.hash], trade.hash), hash: '0'.repeat(64) };
  assert.throws(() => ledger.merge([tampered]), (err) => {
    assert.equal(err.code, 'invalid-hash');
    return true;
  });

  // conflicting second trade with the same business id
  const dupTrade = makeEvent('x5', 'trade', 'T1', []);
  assert.throws(() => ledger.merge([dupTrade]), (err) => {
    assert.equal(err.code, 'duplicate-trade');
    return true;
  });

  assert.equal(ledger.size, 1); // failed merges leave the ledger untouched
});

test('getState on unknown trade throws unknown-trade', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.getState('NOPE'), (err) => {
    assert.equal(err.code, 'unknown-trade');
    return true;
  });
});
