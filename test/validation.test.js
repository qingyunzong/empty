import test from 'node:test';
import assert from 'node:assert/strict';
import { mktmp, runCli, seedDir, basePlan } from '../support/helpers.js';

function setup(constraints = { budget: 100 }) {
  const root = mktmp();
  const A = seedDir(root, 'A', undefined, constraints);
  return A;
}

test('capability violation rejected with exit 2 and JSON stderr', () => {
  const A = setup();
  const r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","machine":"M1"}']);
  assert.equal(r.code, 2);
  assert.equal(r.errJson.error.code, 2);
  assert.equal(r.errJson.error.type, 'validation');
  assert.ok(r.errJson.error.violations.some((v) => v.type === 'capability'));
});

test('precedence violation rejected with exit 2', () => {
  const A = setup();
  const r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":0}']);
  assert.equal(r.code, 2);
  assert.ok(r.errJson.error.violations.some((v) => v.type === 'precedence'));
});

test('machine overlap rejected with exit 2', () => {
  const A = setup();
  const r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","machine":"M2","start":1}']);
  assert.equal(r.code, 2);
  assert.ok(r.errJson.error.violations.some((v) => v.type === 'overlap'));
});

test('due-date penalty budget exceeded rejected with exit 2', () => {
  const A = setup({ budget: 0 });
  const r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","start":5}']);
  assert.equal(r.code, 2);
  assert.ok(r.errJson.error.violations.some((v) => v.type === 'budget'));
});

test('cancel of op with dependents rejected; plain cancel accepted', () => {
  const A = setup();
  let r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'cancel', '--data', '{"id":"o1"}']);
  assert.equal(r.code, 2);
  assert.ok(r.errJson.error.violations.some((v) => v.type === 'has-dependents'));

  r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'cancel', '--data', '{"id":"o3"}']);
  assert.equal(r.code, 0, r.stderr);
  const v = runCli(['verify', '--dir', A]);
  assert.equal(v.code, 0);
});

test('duplicate insert rejected; valid insert accepted', () => {
  const A = setup();
  let r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'insert',
    '--data', '{"id":"o1","job":"j1","machine":"M1","start":0,"dur":1}']);
  assert.equal(r.code, 2);

  r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'insert',
    '--data', '{"id":"o4","job":"j2","machine":"M3","start":3,"dur":1,"preds":["o3"],"machines":["M3"]}']);
  assert.equal(r.code, 0, r.stderr);
  const v = runCli(['verify', '--dir', A]);
  assert.equal(v.code, 0);
});

test('verify on plan violating budget exits 2', () => {
  const root = mktmp();
  const tardy = basePlan();
  tardy.ops[2].start = 2; // o3 ends at 5, job j2 due 4 -> penalty 2
  const A = seedDir(root, 'A', tardy, { budget: 0 });
  const r = runCli(['verify', '--dir', A]);
  assert.equal(r.code, 2, 'seed plan already exceeds zero budget');
  assert.ok(r.json.violations.some((v) => v.type === 'budget'));
});

test('unknown command exits 1 with JSON usage error', () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.code, 1);
  assert.equal(r.errJson.error.type, 'usage');
});
