import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeStore } from '../src/store.js';
import { referencePair, referenceFrozen } from '../src/reference.js';
import { tmpdir, mulberry32 } from './helpers.js';

test('net and margin match reference implementation under random ops', () => {
  const store = TradeStore.open(tmpdir(), { marginRate: 0.1 });
  const rnd = mulberry32(42);
  const parties = ['A', 'B', 'C', 'D'];
  let seq = 0;
  for (let i = 0; i < 300; i++) {
    if (rnd() < 0.7 || store.trades.size === 0) {
      const buyer = parties[Math.floor(rnd() * parties.length)];
      let seller = parties[Math.floor(rnd() * parties.length)];
      if (seller === buyer) seller = parties[(parties.indexOf(buyer) + 1) % parties.length];
      store.addTrade({
        id: `T${++seq}`,
        buyer,
        seller,
        amount: 1 + Math.floor(rnd() * 500),
        desc: `trade ${i}`,
      });
    } else {
      const active = [...store.trades.values()].filter((t) => t.state === 'active');
      if (active.length > 0) {
        store.revokeTrade(active[Math.floor(rnd() * active.length)].id);
      }
    }
    const all = [...store.trades.values()];
    for (const a of parties) {
      for (const b of parties) {
        if (a >= b) continue;
        const ref = referencePair(all, a, b, 0.1);
        const got = store.pairSettlement(a, b);
        assert.deepStrictEqual(
          { net: got.net, payer: got.payer, payee: got.payee, frozen: got.frozen },
          { net: ref.net, payer: ref.payer, payee: ref.payee, frozen: ref.margin },
          `pair ${a}/${b} at step ${i}`,
        );
      }
    }
    const refFrozen = referenceFrozen(all, 0.1);
    for (const p of parties) {
      assert.strictEqual(store.ledger.frozenOf(p), refFrozen.get(p) ?? 0, `frozen ${p} step ${i}`);
    }
  }
});

test('net reversal releases old freeze and freezes new direction in one atomic batch', () => {
  const store = TradeStore.open(tmpdir(), { marginRate: 0.1 });
  store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 100, desc: 'first' });
  let s = store.pairSettlement('A', 'B');
  assert.deepStrictEqual(
    { payer: s.payer, payee: s.payee, net: s.net, frozen: s.frozen },
    { payer: 'A', payee: 'B', net: -100, frozen: 10 },
  );
  assert.strictEqual(store.ledger.frozenOf('A'), 10);

  const cert = store.addTrade({ id: 'T2', buyer: 'B', seller: 'A', amount: 250, desc: 'second' }).settlement;
  assert.strictEqual(cert.reversed, true);
  assert.deepStrictEqual(cert.direction, { payer: 'B', payee: 'A' });
  assert.strictEqual(cert.net, 150);
  assert.deepStrictEqual(cert.batch, [
    { op: 'release', account: 'A', amount: 10 },
    { op: 'freeze', account: 'B', amount: 15 },
  ]);
  assert.strictEqual(store.ledger.frozenOf('A'), 0);
  assert.strictEqual(store.ledger.frozenOf('B'), 15);

  const cert2 = store.revokeTrade('T2');
  assert.strictEqual(cert2.reversed, true);
  assert.deepStrictEqual(cert2.direction, { payer: 'A', payee: 'B' });
  assert.deepStrictEqual(cert2.batch, [
    { op: 'release', account: 'B', amount: 15 },
    { op: 'freeze', account: 'A', amount: 10 },
  ]);
  assert.strictEqual(store.ledger.frozenOf('B'), 0);
  assert.strictEqual(store.ledger.frozenOf('A'), 10);
});

test('failed freeze is atomic: no partial release or freeze lands', () => {
  const dir = tmpdir();
  const store = TradeStore.open(dir, { marginRate: 0.1 });
  store.ledger.setBalance('A', 12);
  store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 100, desc: 'x' });
  assert.strictEqual(store.ledger.frozenOf('A'), 10);
  const before = store.snapshot();
  assert.throws(
    () => store.addTrade({ id: 'T2', buyer: 'A', seller: 'B', amount: 100, desc: 'y' }),
    (err) => err.code === 'INSUFFICIENT_FUNDS',
  );
  assert.strictEqual(store.snapshot(), before);
  assert.strictEqual(store.ledger.frozenOf('A'), 10);
});
