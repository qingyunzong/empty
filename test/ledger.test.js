'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, LedgerError, hashEvent } = require('../src/ledger');

function tradeEvent(id, tradeId, prev = null) {
  return { id, type: 'trade', tradeId, prev };
}
function cancelEvent(id, tradeId, tradeHash, prev) {
  return { id, type: 'cancel', tradeId, tradeHash, prev };
}
function restoreEvent(id, tradeId, cancelHash, prev) {
  return { id, type: 'restore', tradeId, cancelHash, prev };
}
function h(e) {
  return hashEvent(e);
}
function expectCode(code, fn) {
  assert.throws(fn, (err) => err instanceof LedgerError && err.code === code);
}

// Independent set-based reference implementation used only by the tests.
function referenceSnapshot(events) {
  const withHash = events.map((e) => ({ ...e, hash: hashEvent(e) }));
  const byHash = new Map(withHash.map((e) => [e.hash, e]));
  const pastCache = new Map();
  function past(hash) {
    if (pastCache.has(hash)) return pastCache.get(hash);
    const e = byHash.get(hash);
    const out = new Set();
    if (e) {
      for (const dep of [e.prev, e.tradeHash, e.cancelHash].filter(Boolean)) {
        out.add(dep);
        for (const x of past(dep)) out.add(x);
      }
    }
    pastCache.set(hash, out);
    return out;
  }
  const snapshot = {};
  for (const t of withHash) {
    if (t.type !== 'trade') continue;
    const cancels = withHash.filter((e) => e.type === 'cancel' && e.tradeId === t.tradeId);
    const restores = withHash.filter((e) => e.type === 'restore' && e.tradeId === t.tradeId);
    const active = cancels
      .filter((c) => !restores.some((r) => past(r.hash).has(c.hash)))
      .map((c) => c.hash)
      .sort();
    snapshot[t.tradeId] = {
      state: active.length ? 'cancelled' : 'active',
      tombstone: active.length ? active[0] : null,
    };
  }
  return snapshot;
}

// Enumerate every topological order of a set of events.
function topoOrders(events) {
  const withHash = events.map((e) => ({ ...e, hash: hashEvent(e) }));
  const hashes = new Set(withHash.map((e) => e.hash));
  const deps = new Map(withHash.map((e) => [
    e.hash,
    [e.prev, e.tradeHash, e.cancelHash].filter((d) => d && hashes.has(d)),
  ]));
  const results = [];
  const chosen = [];
  const used = new Set();
  (function backtrack() {
    if (chosen.length === withHash.length) {
      results.push(chosen.slice());
      return;
    }
    for (const e of withHash) {
      if (used.has(e.hash)) continue;
      if (!deps.get(e.hash).every((d) => used.has(d))) continue;
      used.add(e.hash);
      chosen.push(e);
      backtrack();
      chosen.pop();
      used.delete(e.hash);
    }
  })();
  return results;
}

test('trade -> cancel -> restore ends active', () => {
  const ledger = new Ledger();
  const T = tradeEvent('t1', 'A');
  ledger.addEvent(T);
  assert.deepEqual(ledger.getTrade('A'), { tradeId: 'A', state: 'active', tombstone: null });

  const C = cancelEvent('c1', 'A', h(T), h(T));
  ledger.addEvent(C);
  const cancelled = ledger.getTrade('A');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.tombstone, h(C));

  const R = restoreEvent('r1', 'A', h(C), h(C));
  ledger.addEvent(R);
  assert.deepEqual(ledger.getTrade('A'), { tradeId: 'A', state: 'active', tombstone: null });
});

test('late replay of an old cancel does not override a causally restored trade', () => {
  const T = tradeEvent('t1', 'A');
  const C = cancelEvent('c1', 'A', h(T), h(T));

  const replicaA = new Ledger();
  replicaA.addEvent(T);
  replicaA.addEvent(C);

  const replicaB = Ledger.fromJSON(JSON.parse(JSON.stringify(replicaA.toJSON())));
  const R = restoreEvent('r1', 'A', h(C), h(C));
  replicaB.addEvent(R);
  assert.equal(replicaB.getTrade('A').state, 'active');

  // Old replica re-broadcasts its stale events; everything is a duplicate.
  const res = replicaB.merge(replicaA.toJSON().events);
  assert.equal(res.added, 0);
  assert.equal(res.duplicates, 2);
  assert.deepEqual(replicaB.getTrade('A'), { tradeId: 'A', state: 'active', tombstone: null });

  // Direct duplicate delivery is idempotent too.
  const dup = replicaB.addEvent(C);
  assert.equal(dup.duplicate, true);
  assert.equal(replicaB.getTrade('A').state, 'active');

  // The stale replica catches up and converges to active.
  replicaA.merge(replicaB.toJSON().events);
  assert.equal(replicaA.getTrade('A').state, 'active');
});

test('restore without observing a cancel is rejected', () => {
  const ledger = new Ledger();
  const T = tradeEvent('t1', 'A');
  ledger.addEvent(T);

  expectCode('restore-without-cancel', () =>
    ledger.addEvent(restoreEvent('r1', 'A', '0'.repeat(64), h(T))));
  // cancelHash pointing at a non-cancel event is also rejected
  expectCode('restore-without-cancel', () =>
    ledger.addEvent(restoreEvent('r2', 'A', h(T), h(T))));
  assert.equal(ledger.getTrade('A').state, 'active');
});

test('cancel of unknown trade is rejected', () => {
  const ledger = new Ledger();
  expectCode('unknown-trade', () =>
    ledger.addEvent(cancelEvent('c1', 'A', '0'.repeat(64), null)));
  expectCode('unknown-trade', () => ledger.getTrade('A'));
});

test('concurrent cancel and restore conflict in both directions', () => {
  const T = tradeEvent('t1', 'A');
  const C1 = cancelEvent('c1', 'A', h(T), h(T));
  const C2 = cancelEvent('c2', 'A', h(T), h(T));
  const R = restoreEvent('r1', 'A', h(C1), h(C1)); // observes C1 only, concurrent with C2

  const ledger = new Ledger();
  ledger.addEvent(T);
  ledger.addEvent(C1);
  ledger.addEvent(C2);
  expectCode('conflict', () => ledger.addEvent(R));

  // Symmetric: restore exists first, then a concurrent cancel arrives.
  const ledger2 = new Ledger();
  ledger2.addEvent(T);
  ledger2.addEvent(C1);
  ledger2.addEvent(R);
  expectCode('conflict', () => ledger2.addEvent(C2));
  assert.equal(ledger2.getTrade('A').state, 'active');
});

test('concurrent cancels keep a single deterministic tombstone; duplicates are idempotent', () => {
  const T = tradeEvent('t1', 'A');
  const C1 = cancelEvent('c1', 'A', h(T), h(T));
  const C2 = cancelEvent('c2', 'A', h(T), h(T));
  const expected = [h(C1), h(C2)].sort()[0];

  for (const order of [[C1, C2], [C2, C1]]) {
    const ledger = new Ledger();
    ledger.addEvent(T);
    ledger.addEvent(order[0]);
    ledger.addEvent(order[1]);
    const status = ledger.getTrade('A');
    assert.equal(status.state, 'cancelled');
    assert.equal(status.tombstone, expected);
    const dup = ledger.addEvent(order[0]);
    assert.equal(dup.duplicate, true);
    assert.equal(ledger.getTrade('A').tombstone, expected);
  }
});

test('duplicate event id with different content is rejected', () => {
  const ledger = new Ledger();
  const T = tradeEvent('t1', 'A');
  ledger.addEvent(T);
  ledger.addEvent(cancelEvent('c1', 'A', h(T), h(T)));
  expectCode('duplicate-event-id', () =>
    ledger.addEvent(cancelEvent('c1', 'A', h(T), null)));
});

test('all topological orders of two trade/cancel/restore chains match the reference', () => {
  const T1 = tradeEvent('t1', 'A');
  const C1 = cancelEvent('c1', 'A', h(T1), h(T1));
  const R1 = restoreEvent('r1', 'A', h(C1), h(C1));
  const T2 = tradeEvent('t2', 'B');
  const C2 = cancelEvent('c2', 'B', h(T2), h(T2));
  const R2 = restoreEvent('r2', 'B', h(C2), h(C2));
  const events = [T1, C1, R1, T2, C2, R2];

  const orders = topoOrders(events);
  assert.equal(orders.length, 20); // 6! / (3! * 3!) interleavings

  for (const order of orders) {
    const ledger = new Ledger();
    const prefix = [];
    for (const e of order) {
      const { hash, ...body } = e;
      const res = ledger.addEvent(body);
      assert.equal(res.duplicate, false);
      prefix.push(e);
      assert.deepEqual(ledger.snapshot(), referenceSnapshot(prefix));
    }
    assert.equal(ledger.getTrade('A').state, 'active');
    assert.equal(ledger.getTrade('B').state, 'active');

    // Merging the second half into a replica holding the first half converges.
    const half = Math.floor(order.length / 2);
    const replica = new Ledger();
    for (const e of order.slice(0, half)) {
      const { hash, ...body } = e;
      replica.addEvent(body);
    }
    replica.merge(order.slice(half));
    assert.deepEqual(replica.snapshot(), referenceSnapshot(order));
  }
});

test('all topological orders of concurrent cancels plus restore match the reference', () => {
  const T = tradeEvent('t1', 'A');
  const C1 = cancelEvent('c1', 'A', h(T), h(T));
  const C2 = cancelEvent('c2', 'A', h(T), h(T));
  // Restore observes both cancels: C1 via cancelHash, C2 via prev.
  const R = restoreEvent('r1', 'A', h(C1), h(C2));
  const events = [T, C1, C2, R];

  const orders = topoOrders(events);
  assert.equal(orders.length, 2);
  const expectedTombstone = [h(C1), h(C2)].sort()[0];

  for (const order of orders) {
    const ledger = new Ledger();
    const prefix = [];
    for (const e of order) {
      const { hash, ...body } = e;
      ledger.addEvent(body);
      prefix.push(e);
      assert.deepEqual(ledger.snapshot(), referenceSnapshot(prefix));
    }
    // Both cancels present before the restore: single deterministic tombstone.
    const beforeRestore = new Ledger();
    beforeRestore.addEvent(T);
    beforeRestore.addEvent(C1);
    beforeRestore.addEvent(C2);
    assert.equal(beforeRestore.getTrade('A').tombstone, expectedTombstone);
    // Final state: restore cleared both cancels.
    assert.deepEqual(ledger.getTrade('A'), { tradeId: 'A', state: 'active', tombstone: null });
  }
});

test('merge is atomic on conflict', () => {
  const T = tradeEvent('t1', 'A');
  const C1 = cancelEvent('c1', 'A', h(T), h(T));
  const C2 = cancelEvent('c2', 'A', h(T), h(T));
  const R = restoreEvent('r1', 'A', h(C1), h(C1));

  const ledger = new Ledger();
  ledger.addEvent(T);
  ledger.addEvent(C1);
  ledger.addEvent(R);

  // Incoming batch contains a new valid event plus a conflicting cancel.
  const T2 = tradeEvent('t2', 'B');
  expectCode('conflict', () => ledger.merge([T2, C2]));
  // Nothing was applied.
  assert.equal(ledger.tradeEvent('B'), null);
  assert.equal(ledger.getTrade('A').state, 'active');
});
