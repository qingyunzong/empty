import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.js';
import { compile } from '../src/compile.js';
import { check } from '../src/linearize.js';
import { E_BOUND } from '../src/errors.js';

const SPEC = `
account acct {
  capacity 10;
  strategy alpha { limit 6; }
  strategy beta  { limit 4; }
  invariant alpha.used + beta.used <= capacity;
}
order o1 { account acct; strategy alpha; amount 6; }
order o2 { account acct; strategy alpha; amount 6; }
order o3 { account acct; strategy beta;  amount 4; }
`;
const model = compile(parseSpec(SPEC));

test('acceptance 1: three concurrent operations, one succeeds and one fails', () => {
  const ops = [
    { id: 'A', kind: 'reserve', order: 'o1', invoke: 1, response: 4, result: 'ok' },
    { id: 'B', kind: 'reserve', order: 'o2', invoke: 2, response: 3, result: 'fail' },
    { id: 'C', kind: 'release', order: 'o1', invoke: 5, response: 6, result: 'ok' },
  ];
  const res = check(model, ops, { max: 8 });
  assert.equal(res.linearizable, true);
  // B before A would have made B succeed, so A must win the race;
  // C is real-time-ordered after both.
  assert.deepEqual(res.orders, [['A', 'B', 'C']]);
});

test('acceptance 2: PENDING operations are not assumed to have failed', () => {
  const ops = [
    { id: 'A', kind: 'reserve', order: 'o1', invoke: 1, response: null, result: null },
    { id: 'B', kind: 'reserve', order: 'o2', invoke: 2, response: 3, result: 'fail' },
  ];
  const res = check(model, ops, { max: 8 });
  assert.equal(res.linearizable, true);
  assert.deepEqual(res.pending, ['A']);
  // Only the completion where A succeeded before B explains B's failure.
  assert.deepEqual(res.orders, [['A', 'B']]);
});

test('PENDING operations cannot rescue an impossible record', () => {
  const ops = [
    { id: 'A', kind: 'reserve', order: 'o1', invoke: 1, response: null, result: null },
    { id: 'B', kind: 'reserve', order: 'o2', invoke: 2, response: 3, result: 'ok' },
    { id: 'C', kind: 'reserve', order: 'o3', invoke: 4, response: 5, result: 'ok' },
  ];
  // o1(6) + o2(6) exceed alpha's limit 6, so if B succeeded then A must be
  // dropped; but o3(4) still needs beta capacity after B, which is fine...
  // except A pending-success would break B, and A dropped leaves C ok:
  // actually [B, C] works, so flip C to alpha to force a conflict.
  const ops2 = [
    { id: 'A', kind: 'reserve', order: 'o1', invoke: 1, response: null, result: null },
    { id: 'B', kind: 'reserve', order: 'o2', invoke: 2, response: 3, result: 'ok' },
    { id: 'C', kind: 'reserve', order: 'o1', invoke: 4, response: 5, result: 'ok' },
  ];
  // C reserves the same order o1: it can only succeed after a release that
  // never happens, and A (pending, same order) cannot fix that.
  const res = check(model, ops2, { max: 8 });
  assert.equal(res.linearizable, false);
  assert.deepEqual(res.orders, []);
});

test('all valid interleavings are emitted in lexicographic order', () => {
  const tight = compile(parseSpec(`
account acct { capacity 6; strategy alpha { limit 6; } }
order o1 { account acct; strategy alpha; amount 3; }
order o2 { account acct; strategy alpha; amount 3; }
`));
  const ops = [
    { id: 'B', kind: 'reserve', order: 'o2', invoke: 1, response: 4, result: 'ok' },
    { id: 'A', kind: 'reserve', order: 'o1', invoke: 2, response: 3, result: 'ok' },
  ];
  const res = check(tight, ops, { max: 8 });
  assert.equal(res.linearizable, true);
  // Both interleavings satisfy the limits; output is sorted lexicographically.
  assert.deepEqual(res.orders, [['A', 'B'], ['B', 'A']]);
});

test('acceptance 5: exceeding the size bound returns E_BOUND instead of a wrong verdict', () => {
  const ops = Array.from({ length: 9 }, (_, i) => ({
    id: `op${i}`, kind: 'reserve', order: 'o1', invoke: i + 1, response: i + 2, result: 'fail',
  }));
  assert.throws(() => check(model, ops, { max: 8 }), (err) => err.code === E_BOUND);
});

test('pending-heavy histories beyond the work cap return E_BOUND', () => {
  const ops = Array.from({ length: 8 }, (_, i) => ({
    id: `op${i}`, kind: 'reserve', order: 'o1', invoke: i + 1, response: null, result: null,
  }));
  // 8! * 2^8 = 10,321,920 > 5,000,000 default work cap
  assert.throws(() => check(model, ops, { max: 8 }), (err) => err.code === E_BOUND);
});
