'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, LedgerError } = require('../ledger');

// ---------------------------------------------------------------------------
// Independent reference algorithm: works purely on the prevHash graph.
// ---------------------------------------------------------------------------
function refByHash(events) {
  return new Map(events.map((e) => [e.hash, e]));
}

// Is `to` reachable from `from` by following prevHash links (inclusive)?
function refReachable(events, from, to) {
  const byHash = refByHash(events);
  let current = byHash.get(to.hash);
  while (current) {
    if (current.hash === from.hash) return true;
    current = current.prevHash ? byHash.get(current.prevHash) : null;
  }
  return false;
}

function refConcurrent(events, a, b) {
  return a.hash !== b.hash && !refReachable(events, a, b) && !refReachable(events, b, a);
}

function refHeads(events, voucherId) {
  const scope = events.filter((e) => e.voucherId === voucherId);
  const hasChild = new Set(scope.map((e) => e.prevHash).filter(Boolean));
  return scope.filter((e) => !hasChild.has(e.hash));
}

function refConflicts(events) {
  const voucherIds = [...new Set(events.map((e) => e.voucherId))];
  const out = {};
  for (const voucherId of voucherIds) {
    const heads = refHeads(events, voucherId);
    for (let i = 0; i < heads.length; i++) {
      for (let j = i + 1; j < heads.length; j++) {
        if (
          refConcurrent(events, heads[i], heads[j]) &&
          (heads[i].amount !== heads[j].amount || heads[i].status !== heads[j].status)
        ) {
          out[voucherId] = heads.map((h) => h.hash).sort();
        }
      }
    }
  }
  return out;
}

// All permutations of `items` that respect the partial order edges (a before b).
function linearExtensions(items, edges) {
  const result = [];
  const before = new Map(items.map((e) => [e.hash, new Set()]));
  for (const [a, b] of edges) before.get(b.hash).add(a.hash);
  const placed = [];
  const used = new Set();
  function step() {
    if (placed.length === items.length) {
      result.push(placed.slice());
      return;
    }
    for (const item of items) {
      if (used.has(item.hash)) continue;
      const deps = before.get(item.hash);
      if ([...deps].every((d) => used.has(d))) {
        used.add(item.hash);
        placed.push(item);
        step();
        placed.pop();
        used.delete(item.hash);
      }
    }
  }
  step();
  return result;
}

function makeThreeEventScenario() {
  const a = new Ledger('A');
  const b = new Ledger('B');
  const e1 = a.put({ voucherId: 'V', amount: 10, status: 'issued' });
  b.merge(a.toJSON()); // B observes e1
  const e2 = a.correct({ voucherId: 'V', amount: 20, status: 'issued' }); // A: causal child of e1
  const e3 = b.correct({ voucherId: 'V', amount: 30, status: 'issued' }); // B: concurrent with e2
  return { events: [e1, e2, e3], edges: [[e1, e2], [e1, e3]] };
}

test('causal correction chain resolves to the latest version', () => {
  const ledger = new Ledger('A');
  ledger.put({ voucherId: 'v1', amount: 100, status: 'issued' });
  ledger.correct({ voucherId: 'v1', amount: 120, status: 'issued' });
  const e3 = ledger.correct({ voucherId: 'v1', amount: 90, status: 'settled' });
  const got = ledger.get('v1');
  assert.equal(got.version, 3);
  assert.equal(got.amount, 90);
  assert.equal(got.status, 'settled');
  assert.equal(got.hash, e3.hash);
  assert.equal(got.conflict, false);
  const cert = ledger.audit();
  assert.equal(cert.status, 'valid');
  assert.equal(cert.conflicts, 0);
  assert.equal(cert.missingDependencies, 0);
  assert.deepEqual(cert.frontier.v1, [e3.hash]);
});

test('two replicas concurrently changing the same amount merge into a visible conflict', () => {
  const a = new Ledger('A');
  const b = new Ledger('B');
  a.put({ voucherId: 'v1', amount: 100, status: 'issued' });
  b.merge(a.toJSON());
  a.correct({ voucherId: 'v1', amount: 150, status: 'issued' });
  b.correct({ voucherId: 'v1', amount: 200, status: 'issued' });
  const result = a.merge(b.toJSON());
  assert.equal(result.merged, 1);
  const got = a.get('v1');
  assert.equal(got.conflict, true);
  assert.deepEqual(got.heads.map((h) => h.amount).sort(), [150, 200]);
  const cert = a.audit();
  assert.equal(cert.status, 'invalid');
  assert.equal(cert.conflicts, 1);
  assert.deepEqual(cert.conflictVouchers, ['v1']);
  assert.equal(cert.frontier.v1.length, 2);
});

test('corrections on different vouchers merge freely without conflict', () => {
  const a = new Ledger('A');
  const b = new Ledger('B');
  a.put({ voucherId: 'v1', amount: 1, status: 'open' });
  b.put({ voucherId: 'v2', amount: 2, status: 'open' });
  a.merge(b.toJSON());
  b.merge(a.toJSON());
  for (const ledger of [a, b]) {
    const cert = ledger.audit();
    assert.equal(cert.status, 'valid');
    assert.equal(cert.conflicts, 0);
    assert.equal(ledger.get('v1').amount, 1);
    assert.equal(ledger.get('v2').amount, 2);
  }
});

test('correct referencing an unobserved version is rejected with unknown-predecessor', () => {
  const ledger = new Ledger('A');
  ledger.put({ voucherId: 'v1', amount: 1, status: 'open' });
  assert.throws(
    () => ledger.correct({ voucherId: 'v1', amount: 2, status: 'open', baseVersion: 7 }),
    (err) => err instanceof LedgerError && err.code === 'unknown-predecessor'
  );
  assert.throws(
    () => ledger.correct({ voucherId: 'v1', amount: 2, status: 'open', prevHash: 'deadbeef' }),
    (err) => err instanceof LedgerError && err.code === 'unknown-predecessor'
  );
});

test('correct referencing an old version is rejected with stale-clock', () => {
  const ledger = new Ledger('A');
  const e1 = ledger.put({ voucherId: 'v1', amount: 1, status: 'open' });
  ledger.correct({ voucherId: 'v1', amount: 2, status: 'open' });
  assert.throws(
    () => ledger.correct({ voucherId: 'v1', amount: 3, status: 'open', baseVersion: 1 }),
    (err) => err instanceof LedgerError && err.code === 'stale-clock'
  );
  assert.throws(
    () => ledger.correct({ voucherId: 'v1', amount: 3, status: 'open', prevHash: e1.hash }),
    (err) => err instanceof LedgerError && err.code === 'stale-clock'
  );
});

test('applyEvent rejects a regressed vector clock with stale-clock', () => {
  const a = new Ledger('A');
  const e1 = a.put({ voucherId: 'v1', amount: 1, status: 'open' });
  const b = new Ledger('B');
  b.applyEvent(e1); // B observes the predecessor
  const forged = {
    voucherId: 'v1',
    version: 2,
    amount: 5,
    status: 'open',
    prevHash: e1.hash,
    clock: { A: 0 }, // regressed: predecessor clock is {A: 1}
  };
  forged.hash = require('../ledger').hashEvent(forged);
  assert.throws(
    () => b.applyEvent(forged),
    (err) => err instanceof LedgerError && err.code === 'stale-clock'
  );
});

test('merge of an event with an unobserved predecessor is tracked as missing dependency', () => {
  const a = new Ledger('A');
  a.put({ voucherId: 'v1', amount: 1, status: 'open' });
  a.correct({ voucherId: 'v1', amount: 2, status: 'open' });
  const e3 = a.correct({ voucherId: 'v1', amount: 3, status: 'open' });
  const b = new Ledger('B');
  // Hand B only e3: its predecessor (v2) is unknown to B.
  const result = b.merge({ replicaId: 'A', events: [e3], missing: [] });
  assert.equal(result.merged, 0);
  assert.equal(result.missing, 1);
  const cert = b.audit();
  assert.equal(cert.status, 'invalid');
  assert.equal(cert.missingDependencies, 1);
  // A later merge delivering the predecessor heals the ledger.
  b.merge(a.toJSON());
  const healed = b.audit();
  assert.equal(healed.status, 'valid');
  assert.equal(healed.missingDependencies, 0);
  assert.equal(b.get('v1').version, 3);
});

test('partial-order enumeration: two replicas, three voucher events', () => {
  const { events, edges } = makeThreeEventScenario();
  const [e1, e2, e3] = events;

  // Reference facts about the poset e1 < e2, e1 < e3, e2 || e3.
  assert.equal(refReachable(events, e1, e3), true);
  assert.equal(refReachable(events, e1, e2), true);
  assert.equal(refConcurrent(events, e2, e3), true);
  const expectedHeads = refHeads(events, 'V').map((e) => e.hash).sort();
  const expectedConflicts = refConflicts(events);

  const orders = linearExtensions(events, edges);
  assert.deepEqual(
    orders.map((o) => o.map((e) => events.indexOf(e))).sort(),
    [[0, 1, 2], [0, 2, 1]]
  );

  for (const order of orders) {
    const merged = new Ledger('M');
    for (const event of order) {
      merged.merge({ replicaId: 'X', events: [event], missing: [] });
    }
    // Version reachability matches the reference graph exactly.
    for (const from of events) {
      for (const to of events) {
        assert.equal(
          merged.isAncestor(from.hash, to.hash),
          refReachable(events, from, to),
          `reachability ${from.hash} -> ${to.hash}`
        );
      }
    }
    // Heads and conflicts match the reference algorithm, order-independently.
    assert.deepEqual(merged.headsOf('V').map((e) => e.hash).sort(), expectedHeads);
    assert.deepEqual(merged.conflicts(), expectedConflicts);
    const cert = merged.audit();
    assert.equal(cert.conflicts, Object.keys(expectedConflicts).length);
    assert.equal(cert.status, 'invalid');
    assert.deepEqual(cert.frontier.V, expectedHeads);
  }
});

test('partial-order enumeration: concurrent identical corrections are not conflicts', () => {
  const a = new Ledger('A');
  const e1 = a.put({ voucherId: 'V', amount: 10, status: 'issued' });
  const b = new Ledger('B');
  b.merge(a.toJSON());
  const e2 = a.correct({ voucherId: 'V', amount: 42, status: 'issued' });
  const e3 = b.correct({ voucherId: 'V', amount: 42, status: 'issued' }); // same value, concurrent
  const events = [e1, e2, e3];
  const edges = [[e1, e2], [e1, e3]];
  assert.deepEqual(refConflicts(events), {});
  for (const order of linearExtensions(events, edges)) {
    const merged = new Ledger('M');
    for (const event of order) {
      merged.merge({ replicaId: 'X', events: [event], missing: [] });
    }
    assert.deepEqual(merged.conflicts(), {});
    assert.equal(merged.audit().status, 'valid');
  }
});
