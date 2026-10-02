import test from 'node:test';
import assert from 'node:assert/strict';
import { MvccStore } from '../src/store.js';
import { RefStore } from '../oracle/refstore.js';

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

function applyOp(target, op) {
  try {
    switch (op.kind) {
      case 'insert':
        target.insert(op.event);
        return { ok: true };
      case 'correct':
        target.correct(op.eventId, op.patch);
        return { ok: true };
      case 'delete':
        target.delete(op.eventId);
        return { ok: true };
      default:
        throw new Error(`bad op ${op.kind}`);
    }
  } catch (err) {
    return { ok: false, code: err.code };
  }
}

const IDS = ['A', 'B', 'C', 'NOPE'];
const DEVICES = ['d1', 'd2', 'dX'];
const RANGES = [
  [0, 1000],
  [100, 200],
  [150, 150],
  [40, 60],
  [500, 100],
];

function compareAll(store, ref, ctx) {
  assert.equal(store.currentTx, ref.seq, `${ctx}: commit sequence diverged`);
  for (let tx = 0; tx <= store.currentTx; tx++) {
    for (const id of IDS) {
      assert.deepEqual(store.get(id, tx), ref.getAt(id, tx), `${ctx}: get(${id}) @tx=${tx}`);
    }
    for (const d of DEVICES) {
      for (const [from, to] of RANGES) {
        assert.deepEqual(
          store.range(d, from, to, tx),
          ref.rangeAt(d, from, to, tx),
          `${ctx}: range(${d}, ${from}, ${to}) @tx=${tx}`,
        );
      }
    }
  }
}

function runPermutation(ops, ctx) {
  const store = new MvccStore();
  const ref = new RefStore();
  for (const op of ops) {
    const actual = applyOp(store, op);
    const expected = applyOp(ref, op);
    assert.deepEqual(actual, expected, `${ctx}: op outcome diverged for ${JSON.stringify(op)}`);
  }
  compareAll(store, ref, ctx);
}

const OP_SETS = {
  'insert/correct/delete over 3 events': [
    { kind: 'insert', event: { eventId: 'A', deviceId: 'd1', validAt: 100, data: { n: 'a1' } } },
    { kind: 'insert', event: { eventId: 'B', deviceId: 'd1', validAt: 200, data: { n: 'b1' } } },
    { kind: 'correct', eventId: 'A', patch: { validAt: 300, data: { n: 'a2' } } },
    { kind: 'delete', eventId: 'B' },
    { kind: 'insert', event: { eventId: 'C', deviceId: 'd2', validAt: 150, data: { n: 'c1' } } },
  ],
  'duplicate insert, delete, re-create, correct-of-missing': [
    { kind: 'insert', event: { eventId: 'A', deviceId: 'd1', validAt: 100, data: { n: 'a1' } } },
    { kind: 'insert', event: { eventId: 'A', deviceId: 'd2', validAt: 999, data: { n: 'a-dup' } } },
    { kind: 'delete', eventId: 'A' },
    { kind: 'correct', eventId: 'A', patch: { data: { n: 'a-corrected' } } },
    { kind: 'insert', event: { eventId: 'B', deviceId: 'd2', validAt: 50, data: { n: 'b1' } } },
  ],
  'index migration across validAt and deviceId': [
    { kind: 'insert', event: { eventId: 'A', deviceId: 'd1', validAt: 100, data: { n: 'a1' } } },
    { kind: 'correct', eventId: 'A', patch: { deviceId: 'd2', validAt: 400 } },
    { kind: 'correct', eventId: 'A', patch: { validAt: 40 } },
    { kind: 'delete', eventId: 'A' },
    { kind: 'insert', event: { eventId: 'B', deviceId: 'd1', validAt: 400, data: { n: 'b1' } } },
  ],
};

for (const [name, ops] of Object.entries(OP_SETS)) {
  test(`permutation enumeration vs naive reference: ${name} (${ops.length} ops)`, () => {
    const perms = permutations(ops);
    assert.equal(perms.length, 120);
    for (let i = 0; i < perms.length; i++) {
      runPermutation(perms[i], `perm#${i}`);
    }
  });
}
