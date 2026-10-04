import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import {
  createLedger,
  commitSession,
  mergeLedgers,
  verifyLedger,
  allStock,
  canonicalize,
} from '../src/ledger.js';
import { makeDir } from './helpers.js';

const KEY = 'A-01|WIP-0001';

async function terminal(nodeId) {
  return Store.open(await makeDir(), { nodeId });
}

test('two terminals converge bidirectionally with merged version vectors', async () => {
  const a = await terminal('t1');
  const b = await terminal('t2');
  await a.begin('s1');
  await a.scan('s1', 'A-01', 'WIP-0001', 2);
  await a.close('s1');
  await b.begin('s1');
  await b.scan('s1', 'A-01', 'WIP-0002', 5);
  await b.close('s1');

  await a.sync(b.dir);
  assert.deepEqual(await a.stock(), { 'A-01|WIP-0001': 2, 'A-01|WIP-0002': 5 });
  assert.deepEqual(await b.stock(), await a.stock(), 'peer converged to the same stock');
  const la = await a.ledger();
  assert.deepEqual(la.vv, { t1: 1, t2: 1 });
  assert.equal((await a.verify()).ok, true);
  assert.equal((await b.verify()).ok, true);
  assert.equal((await a.verify(b.dir)).converged, true);
});

test('concurrent adjusts on the same item merge commutatively', async () => {
  const a = await terminal('t1');
  const b = await terminal('t2');
  await a.setBase('A-01', 'WIP-0001', 10);
  await a.sync(b.dir); // both start from base 10

  await a.begin('s1');
  await a.adjust('s1', 'A-01', 'WIP-0001', -4);
  await a.close('s1');
  await b.begin('s2');
  await b.adjust('s2', 'A-01', 'WIP-0001', -3);
  await b.close('s2');

  await a.sync(b.dir);
  assert.equal((await a.stock())[KEY], 3);
  assert.equal((await b.stock())[KEY], 3);
  assert.deepEqual((await a.ledger()).pending, []);
});

test('merge causing negative inventory goes to pending instead of failing', async () => {
  const a = await terminal('t1');
  const b = await terminal('t2');
  await a.setBase('A-01', 'WIP-0001', 5);
  await a.sync(b.dir);

  await a.begin('s1');
  await a.adjust('s1', 'A-01', 'WIP-0001', -4);
  await a.close('s1');
  await b.begin('s2');
  await b.adjust('s2', 'A-01', 'WIP-0001', -4);
  await b.close('s2');

  const result = await a.sync(b.dir); // 5 - 4 - 4 < 0: must not throw
  assert.equal(result.stock[KEY], 1, 'largest node id delta (t2) is deferred');
  assert.equal(result.pending.length, 1);
  assert.deepEqual(result.pending[0], {
    key: KEY,
    node: 't2',
    seq: 1,
    delta: -4,
    reason: 'negative-inventory',
  });
  assert.equal((await a.verify()).ok, true, 'pending is explained, ledger stays consistent');

  // later stock lets the pending delta apply
  await a.begin('s3');
  await a.scan('s3', 'A-01', 'WIP-0001', 5);
  await a.close('s3');
  const after = await a.sync(b.dir);
  assert.equal(after.stock[KEY], 2);
  assert.deepEqual(after.pending, []);
  assert.equal((await b.stock())[KEY], 2);
});

test('three terminals converge regardless of sync order', async () => {
  const nodes = [];
  for (const id of ['t1', 't2', 't3']) {
    const store = await terminal(id);
    await store.setBase('A-01', 'WIP-0001', 20);
    nodes.push(store);
  }
  for (const [idx, store] of nodes.entries()) {
    await store.begin('s1');
    await store.adjust('s1', 'A-01', 'WIP-0001', -(idx + 2));
    await store.close('s1');
  }
  // ring sync: t1<-t2, t2<-t3, t1<-t2 (carries t3), then everyone with t1
  await nodes[0].sync(nodes[1].dir);
  await nodes[1].sync(nodes[2].dir);
  await nodes[0].sync(nodes[1].dir);
  await nodes[1].sync(nodes[0].dir);
  await nodes[2].sync(nodes[0].dir);
  const stocks = await Promise.all(nodes.map((n) => n.stock()));
  for (const stock of stocks) assert.equal(stock[KEY], 20 - 2 - 3 - 4);
  assert.equal((await nodes[0].verify(nodes[1].dir)).converged, true);
  assert.equal((await nodes[1].verify(nodes[2].dir)).converged, true);
});

function* permutations(items) {
  const a = [...items];
  const n = a.length;
  const c = new Array(n).fill(0);
  yield [...a];
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [a[i], a[j]] = [a[j], a[i]];
      yield [...a];
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

test('n<=8: enumerate every merge order, all legal results are identical', (t) => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const nodeLedgers = [];
    for (let i = 0; i < n; i += 1) {
      const ledger = createLedger();
      ledger.base[KEY] = 12;
      ledger.base['B-02|WIP-0002'] = 0;
      commitSession(ledger, `n${i}`, 's1', [
        { key: KEY, delta: -(i + 1) },
        { key: 'B-02|WIP-0002', delta: i },
      ]);
      nodeLedgers.push(ledger);
    }

    let reference = null;
    let orders = 0;
    for (const order of permutations(nodeLedgers)) {
      let acc = createLedger();
      acc.base[KEY] = 12;
      acc.base['B-02|WIP-0002'] = 0;
      for (const ledger of order) acc = mergeLedgers(acc, ledger);
      const canonical = JSON.stringify(canonicalize(acc));
      if (reference === null) reference = canonical;
      assert.equal(canonical, reference, `n=${n}: merge order produced a different result`);
      orders += 1;
    }
    assert.equal(orders, factorial(n), `n=${n}: enumerated all orders`);

    const final = JSON.parse(reference);
    const report = verifyLedger(final);
    assert.equal(report.ok, true, `n=${n}: converged ledger is verifiable`);
    assert.equal(report.stock[KEY] >= 0, true, `n=${n}: stock never negative`);
    t.diagnostic(
      `n=${n}: ${orders} orders, stock=${report.stock[KEY]}, pending=${final.pending.length}`,
    );
  }
});

test('n=8 pending set is deterministic and explainable', () => {
  const nodeLedgers = [];
  for (let i = 0; i < 8; i += 1) {
    const ledger = createLedger();
    ledger.base[KEY] = 12;
    commitSession(ledger, `n${i}`, 's1', [{ key: KEY, delta: -(i + 1) }]);
    nodeLedgers.push(ledger);
  }
  let acc = createLedger();
  acc.base[KEY] = 12;
  for (const ledger of nodeLedgers) acc = mergeLedgers(acc, ledger);
  // total delta = -36 against base 12: n7..n4 are deferred (largest node id first)
  assert.equal(allStock(acc)[KEY], 2);
  assert.deepEqual(
    acc.pending.map((p) => p.node),
    ['n4', 'n5', 'n6', 'n7'],
  );
  assert.ok(acc.pending.every((p) => p.reason === 'negative-inventory'));
});
