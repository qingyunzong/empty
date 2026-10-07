import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RefStore } from '../reference/ref-store.js';
import { canonical } from '../src/canonical.js';

// Exhaustive differential test: every history of up to MAX_OPS operations
// over at most MAX_TXS transactions, drawn from a small alphabet that
// includes the required edge cases (empty key, zero-length work order "",
// same-value duplicate writes, slot collisions, slot swaps).
const MAX_OPS = 4;
const MAX_TXS = 2;
const KEYS = ['', 'a', 'b'];
const VALUES = [
  '',
  { workcenter: 'w1', timeSlot: 't1' },
  { workcenter: 'w1', timeSlot: 't2' },
];

function* histories(state = { ops: [], begun: 0, open: [] }) {
  if (state.ops.length === MAX_OPS) {
    yield state.ops;
    return;
  }
  if (state.begun < MAX_TXS) {
    yield* histories({
      ops: [...state.ops, { op: 'begin' }],
      begun: state.begun + 1,
      open: [...state.open, 'tx' + (state.begun + 1)],
    });
  }
  for (const tx of state.open) {
    for (const key of KEYS) {
      for (const value of VALUES) {
        yield* histories({ ...state, ops: [...state.ops, { op: 'put', tx, key, value }] });
      }
      yield* histories({ ...state, ops: [...state.ops, { op: 'get', tx, key }] });
    }
    const rest = state.open.filter((t) => t !== tx);
    yield* histories({ ops: [...state.ops, { op: 'commit', tx }], begun: state.begun, open: rest });
    yield* histories({ ops: [...state.ops, { op: 'abort', tx }], begun: state.begun, open: rest });
  }
}

function runOp(store, op) {
  try {
    switch (op.op) {
      case 'begin':
        return { ok: true, tx: store.begin() };
      case 'get':
        return { ok: true, value: store.get(op.tx, op.key) };
      case 'put':
        store.put(op.tx, op.key, op.value);
        return { ok: true };
      case 'commit':
        return { ok: true, version: store.commit(op.tx) };
      case 'abort':
        store.abort(op.tx);
        return { ok: true };
      default:
        throw new Error('bad op');
    }
  } catch (err) {
    return { ok: false, code: err.code };
  }
}

test('enumeration: all histories (<=2 tx, <=4 ops) match naive reference', () => {
  let count = 0;
  for (const ops of histories()) {
    count++;
    const store = new Store();
    const ref = new RefStore();
    for (let i = 0; i < ops.length; i++) {
      const actual = runOp(store, ops[i]);
      const expected = runOp(ref, ops[i]);
      assert.equal(
        canonical(actual),
        canonical(expected),
        `step ${i} diverged\nhistory: ${canonical(ops)}\nstore: ${canonical(actual)}\nref:   ${canonical(expected)}`
      );
    }
    // Final committed state must also agree.
    assert.equal(
      canonical(store.dataAt(store.latest)),
      canonical(ref.versions[ref.versions.length - 1].data),
      `final state diverged\nhistory: ${canonical(ops)}`
    );
  }
  assert.equal(count, 3276); // guard: alphabet/depth changes are intentional
});
