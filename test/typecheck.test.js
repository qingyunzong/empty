import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../src/parser.js';
import { compile } from '../src/compile.js';
import { normalizeHistory, typecheckHistory } from '../src/history.js';
import { E_TYPE } from '../src/errors.js';

const SPEC = `
account acct {
  capacity 10;
  strategy alpha { limit 6; }
  strategy beta  { limit 4; }
  invariant alpha.used + beta.used <= capacity;
}
order o1 { account acct; strategy alpha; amount 6; }
order o2 { account acct; strategy alpha; amount 6; }
`;

const model = compile(parseSpec(SPEC));

const expectTypeError = (fn, pattern) => {
  assert.throws(fn, (err) => err.code === E_TYPE && pattern.test(err.message));
};

test('strategy sub-limits must not exceed account capacity', () => {
  const bad = SPEC.replace('limit 4', 'limit 5');
  expectTypeError(() => compile(parseSpec(bad)), /sub-limits sum to 11, exceeding capacity 10/);
});

test('confirm may only consume an existing reserve', () => {
  const ops = normalizeHistory([
    { id: 'A', op: 'confirm', order: 'o1', invoke: 1, response: 2, result: 'ok' },
  ]);
  expectTypeError(() => typecheckHistory(model, ops), /confirm 'A' has no matching reserve/);
});

test('duplicate release is rejected statically', () => {
  const ops = normalizeHistory([
    { id: 'A', op: 'reserve', order: 'o1', invoke: 1, response: 2, result: 'ok' },
    { id: 'B', op: 'release', order: 'o1', invoke: 3, response: 4, result: 'ok' },
    { id: 'C', op: 'release', order: 'o1', invoke: 5, response: 6, result: 'fail' },
  ]);
  expectTypeError(() => typecheckHistory(model, ops), /duplicate release of order 'o1'/);
});

test('operations must reference declared orders', () => {
  const ops = normalizeHistory([
    { id: 'A', op: 'reserve', order: 'o9', invoke: 1, response: 2, result: 'ok' },
  ]);
  expectTypeError(() => typecheckHistory(model, ops), /undeclared order 'o9'/);
});

test('orders must reference declared accounts and strategies', () => {
  expectTypeError(
    () => compile(parseSpec(`${SPEC}\norder o9 { account nope; strategy alpha; amount 1; }`)),
    /unknown account 'nope'/,
  );
  expectTypeError(
    () => compile(parseSpec(`${SPEC}\norder o9 { account acct; strategy nope; amount 1; }`)),
    /unknown strategy 'nope'/,
  );
});

test('invariants may only reference capacity, used, and strategy fields', () => {
  const bad = SPEC.replace('alpha.used + beta.used <= capacity', 'gamma.used <= capacity');
  expectTypeError(() => compile(parseSpec(bad)), /unknown reference 'gamma.used'/);
});

test('capacity and limits must be constant expressions', () => {
  const bad = SPEC.replace('capacity 10', 'capacity alpha.limit');
  expectTypeError(() => compile(parseSpec(bad)), /must be a constant expression/);
});

test('response must not precede invoke on the logical clock', () => {
  expectTypeError(
    () => normalizeHistory([{ id: 'A', op: 'reserve', order: 'o1', invoke: 5, response: 2, result: 'ok' }]),
    /'response' must be an integer >= invoke/,
  );
});
