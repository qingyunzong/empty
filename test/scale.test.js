import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

test('scale: 50k mixed operations with batches and undos stay consistent', () => {
  const ledger = new Ledger({ budget: 100_000_000 });
  const N = 50_000;
  const start = Date.now();
  let ok = 0;
  let errors = 0;
  for (let i = 0; i < N; i++) {
    const acc = `acc${i % 100}`;
    let res;
    switch (i % 20) {
      case 0:
        res = ledger.execute({ op: 'batchBegin', id: `S${i}` });
        break;
      case 5:
        res = ledger.execute({ op: 'batchEnd' });
        break;
      case 10:
        res = ledger.execute({ op: 'transfer', from: 'acc0', to: acc, amount: 1 });
        break;
      case 15:
        res = ledger.execute({ op: 'undo' });
        break;
      case 18:
        res = ledger.execute({ op: 'withdraw', account: acc, amount: 1 });
        break;
      default:
        res = ledger.execute({ op: 'deposit', account: acc, amount: 10 });
      // note: case 5 batchEnd often errors (no open batch) - counted as errors
    }
    if (res.status === 'ok') ok++;
    else errors++;
    const st = res.state;
    for (const name of Object.keys(st.accounts)) {
      const a = st.accounts[name];
      assert.ok(a.balance >= 0 && a.frozen >= 0 && a.frozen <= a.balance, `invariant at step ${i}`);
    }
    assert.ok(st.budget === null || st.budget >= 0);
  }
  const elapsed = Date.now() - start;
  assert.ok(ok > 0 && errors > 0);
  assert.ok(elapsed < 60_000, `took ${elapsed}ms`);
  console.log(`50k ops: ok=${ok} errors=${errors} elapsed=${elapsed}ms`);
});
