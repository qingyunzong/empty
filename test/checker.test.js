import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../src/index.js';

const wrap = (body) => `for tx in txns(txn:1) { ${body} }`;

test('types: Amount vs String mismatch is rejected', () => {
  assert.throws(
    () => compilePlan(wrap('when tx.amount > "x" { revoke tx; }')),
    (e) => e.code === 'E_TYPE',
  );
});

test('types: revoke requires a txn operand', () => {
  assert.throws(() => compilePlan(wrap('revoke 12.50;')), (e) => e.code === 'E_TYPE');
});

test('types: revoke compiles to paired-entry txn-level ops', () => {
  const program = compilePlan(wrap('revoke tx;'));
  const ops = program.code.map((i) => i.op);
  for (const op of ['SAVEPOINT', 'LOCK_CHECK', 'DISPATCH', 'REVERSE', 'COMPENSATE', 'CANCEL_REQUEST', 'COMMIT']) {
    assert.ok(ops.includes(op), `bytecode contains ${op}`);
  }
});

test('scope: let at top level is rejected, param is the only global', () => {
  assert.throws(() => compilePlan('let x = 1;'), (e) => e.code === 'E_SCOPE');
});

test('scope: loop variable shadowing a param is rejected', () => {
  assert.throws(
    () => compilePlan('param tx = 1; for tx in txns(*) { revoke tx; }'),
    (e) => e.code === 'E_SCOPE',
  );
});

test('scope: txn-local not visible in a later loop', () => {
  const src = `${wrap('let y = 1;')} for t2 in txns(*) { when t2.amount > y { revoke t2; } }`;
  assert.throws(() => compilePlan(src), (e) => e.code === 'E_SCOPE');
});

test('scope: params are visible as globals inside loops', () => {
  const program = compilePlan('param limit = 100.00; for tx in txns(*) { when tx.amount > limit { revoke tx; } }');
  assert.equal(program.params.limit.v, 10000);
});

test('state machine: revoke guarded by terminal status is statically illegal', () => {
  assert.throws(
    () => compilePlan(wrap('when tx.status == REVERSED { revoke tx; }')),
    (e) => e.code === 'E_STATE',
  );
  assert.throws(
    () => compilePlan(wrap('when tx.status == CANCEL_REQUESTED and tx.amount > 0.00 { revoke tx; }')),
    (e) => e.code === 'E_STATE',
  );
});

test('state machine: SETTLED/PENDING/LOCKED guards are legal', () => {
  compilePlan(wrap('when tx.status == SETTLED or tx.status == PENDING { revoke tx; }'));
  compilePlan(wrap('when tx.status == LOCKED { revoke tx; }'));
});

test('revId: explicit param wins, otherwise hash of source', () => {
  const a = compilePlan('param rev_id = "r1"; revoke txn:1;');
  assert.equal(a.revId, 'r1');
  const b = compilePlan('revoke txn:1;');
  const c = compilePlan('revoke txn:2;');
  assert.match(b.revId, /^[0-9a-f]{16}$/);
  assert.notEqual(b.revId, c.revId);
});
