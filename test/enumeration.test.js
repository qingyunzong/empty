// Acceptance 3: enumerate every history of at most 2 transactions and at most
// 4 get/put operations (2 per transaction), run each history against both the
// real MVCC store and the naive "copy array + visibility rules" reference,
// and require identical observable behavior for every single history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RefStore } from './helpers/reference.js';

const KEYS = ['', 'a']; // includes the empty key
const VALUES = [
  { workcenter: 'w1', timeSlot: 't1' },
  { workcenter: 'w1', timeSlot: 't2' },
];
const MAX_TX = 2;
const MAX_OPS_PER_TX = 2; // <= 4 operations total

function* histories() {
  const txs = Array.from({ length: MAX_TX }, () => ({ status: 'idle', ops: 0 }));
  const seq = [];
  yield* step(txs, seq);
}

function* step(txs, seq) {
  const anyActive = txs.some((t) => t.status === 'active');
  const anyStarted = txs.some((t) => t.status !== 'idle');
  if (!anyActive && anyStarted) yield seq; // every fully-closed prefix is a history
  for (let i = 0; i < txs.length; i += 1) {
    const tx = txs[i];
    if (tx.status === 'idle') {
      tx.status = 'active';
      seq.push({ op: 'begin', tx: i });
      yield* step(txs, seq);
      seq.pop();
      tx.status = 'idle';
    } else if (tx.status === 'active') {
      if (tx.ops < MAX_OPS_PER_TX) {
        for (const key of KEYS) {
          tx.ops += 1;
          seq.push({ op: 'get', tx: i, key });
          yield* step(txs, seq);
          seq.pop();
          tx.ops -= 1;
        }
        for (const key of KEYS) {
          for (const value of VALUES) {
            tx.ops += 1;
            seq.push({ op: 'put', tx: i, key, value });
            yield* step(txs, seq);
            seq.pop();
            tx.ops -= 1;
          }
        }
      }
      for (const op of ['commit', 'abort']) {
        tx.status = 'done';
        seq.push({ op, tx: i });
        yield* step(txs, seq);
        seq.pop();
        tx.status = 'active';
      }
    }
  }
}

function run(seq, makeStore) {
  const store = makeStore();
  const txs = new Map();
  const out = [];
  for (const cmd of seq) {
    switch (cmd.op) {
      case 'begin':
        txs.set(cmd.tx, store.begin());
        out.push({ ok: true });
        break;
      case 'get': {
        const value = txs.get(cmd.tx).get(cmd.key);
        out.push({ ok: true, value: value === undefined ? null : value });
        break;
      }
      case 'put':
        txs.get(cmd.tx).put(cmd.key, cmd.value);
        out.push({ ok: true });
        break;
      case 'commit':
      case 'abort':
        try {
          txs.get(cmd.tx)[cmd.op]();
          out.push({ ok: true });
        } catch (err) {
          out.push({ ok: false, code: err.code });
        }
        break;
      default:
        throw new Error(`unknown op ${cmd.op}`);
    }
  }
  return out;
}

test('acceptance 3: all histories (<=2 tx, <=4 ops) match the naive reference', () => {
  let count = 0;
  for (const seq of histories()) {
    count += 1;
    const actual = run(seq, () => new Store());
    const expected = run(seq, () => new RefStore());
    assert.deepStrictEqual(
      actual,
      expected,
      `divergence on history #${count}: ${JSON.stringify(seq)}`,
    );
  }
  assert.ok(count > 100000, `expected a meaningful enumeration, got only ${count} histories`);
  console.log(`enumerated ${count} histories, all matched the reference`);
});
