import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateHistory } from '../src/validate.js';
import { checkLinearizable } from '../src/checker.js';
import { createState, applyOp, responseMatches } from '../src/model.js';

const fixture = async (name) =>
  validateHistory(JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')));

// Replays a witness and asserts it is a genuine linearization.
function assertValidWitness(ops, witness, initial) {
  assert.equal(witness.length, ops.length);
  assert.deepEqual(new Set(witness), new Set(ops.map((o) => o.opId)));
  const byId = new Map(ops.map((o) => [o.opId, o]));
  const order = witness.map((id) => byId.get(id));
  // real-time consistency
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      assert.ok(
        order[j].responseTime > order[i].invocationTime,
        `real-time violated: ${order[j].opId} responded before ${order[i].opId} was invoked`
      );
    }
  }
  // sequential replay reproduces recorded responses
  const state = createState(initial);
  for (const op of order) {
    assert.ok(responseMatches(applyOp(state, op), op), `response mismatch at ${op.opId}`);
  }
}

test('acceptance 1: overlapping reads may observe old or new values', async () => {
  const ops = await fixture('overlapping-read.json');
  const initial = { alice: 1000 };
  const result = checkLinearizable(ops, { initial });
  assert.equal(result.linearizable, true);
  assertValidWitness(ops, result.witness, initial);
  // read-old must precede the reserve, read-new must follow it
  assert.ok(result.witness.indexOf('read-old') < result.witness.indexOf('res1'));
  assert.ok(result.witness.indexOf('res1') < result.witness.indexOf('read-new'));
  // linearization points fall inside their intervals and are monotone
  const byId = new Map(ops.map((o) => [o.opId, o]));
  let previous = -Infinity;
  for (let k = 0; k < result.witness.length; k++) {
    const op = byId.get(result.witness[k]);
    const lp = result.linearizationPoints[k];
    assert.ok(lp >= op.invocationTime && lp <= op.responseTime, `lp of ${op.opId} in interval`);
    assert.ok(lp >= previous);
    previous = lp;
  }
  console.log(`WITNESS overlapping-read: ${result.witness.join(' -> ')} @ lp=${JSON.stringify(result.linearizationPoints)}`);
});

test('acceptance 2: commit succeeding after a responded cancel is not linearizable', async () => {
  const ops = await fixture('cancel-then-commit.json');
  const result = checkLinearizable(ops, { initial: { alice: 1000 } });
  assert.equal(result.linearizable, false);
  assert.match(result.conflict, /com1/);
  assert.match(result.conflict, /cancelled/);
  console.log(`CONFLICT cancel-then-commit: ${result.conflict}`);
});

test('zero amount reserve succeeds, holds nothing, and can be committed', async () => {
  const ops = await fixture('zero-amount.json');
  const result = checkLinearizable(ops, { initial: { alice: 1000 } });
  assert.equal(result.linearizable, true);
  assertValidWitness(ops, result.witness, { alice: 1000 });
});

test('zero amount reserve succeeds even with zero balance', () => {
  const ops = validateHistory([
    { client: 'c', opId: 'z', invocationTime: 0, responseTime: 1,
      type: 'reserve', account: 'bob', amount: 0, reserveId: 'z0', ok: true },
  ]);
  assert.equal(checkLinearizable(ops).linearizable, true);
});

test('unknown reserveId: failing commit/cancel is linearizable', async () => {
  const ops = await fixture('unknown-reserveid.json');
  const result = checkLinearizable(ops);
  assert.equal(result.linearizable, true);
});

test('unknown reserveId: successful commit is impossible', () => {
  const ops = validateHistory([
    { client: 'c', opId: 'bad', invocationTime: 0, responseTime: 1,
      type: 'commit', account: 'alice', reserveId: 'ghost', ok: true },
  ]);
  const result = checkLinearizable(ops);
  assert.equal(result.linearizable, false);
  assert.match(result.conflict, /unknown reserveId/);
});

test('commit succeeds exactly once', () => {
  const ops = validateHistory([
    { client: 'c', opId: 'res', invocationTime: 0, responseTime: 2,
      type: 'reserve', account: 'a', amount: 5, reserveId: 'r', ok: true },
    { client: 'c', opId: 'c1', invocationTime: 3, responseTime: 4,
      type: 'commit', account: 'a', reserveId: 'r', ok: true },
    { client: 'c', opId: 'c2', invocationTime: 5, responseTime: 6,
      type: 'commit', account: 'a', reserveId: 'r', ok: true },
  ]);
  const result = checkLinearizable(ops, { initial: { a: 10 } });
  assert.equal(result.linearizable, false);
});

test('real-time order: a read invoked after a reserve responded must see the hold', () => {
  const ops = validateHistory([
    { client: 'c1', opId: 'res', invocationTime: 0, responseTime: 5,
      type: 'reserve', account: 'a', amount: 40, reserveId: 'r', ok: true },
    { client: 'c2', opId: 'rd', invocationTime: 6, responseTime: 8,
      type: 'read', account: 'a', ok: true, result: { balance: 100, frozen: 0 } },
  ]);
  const result = checkLinearizable(ops, { initial: { a: 100 } });
  assert.equal(result.linearizable, false);
});

test('cancel returns funds to the balance', () => {
  const ops = validateHistory([
    { client: 'c', opId: 'res', invocationTime: 0, responseTime: 2,
      type: 'reserve', account: 'a', amount: 30, reserveId: 'r', ok: true },
    { client: 'c', opId: 'can', invocationTime: 3, responseTime: 4,
      type: 'cancel', account: 'a', reserveId: 'r', ok: true },
    { client: 'c', opId: 'rd', invocationTime: 5, responseTime: 6,
      type: 'read', account: 'a', ok: true, result: { balance: 100, frozen: 0 } },
  ]);
  const result = checkLinearizable(ops, { initial: { a: 100 } });
  assert.equal(result.linearizable, true);
  assertValidWitness(ops, result.witness, { a: 100 });
});

test('reserve failing for insufficient funds is linearizable', () => {
  const ops = validateHistory([
    { client: 'c', opId: 'big', invocationTime: 0, responseTime: 1,
      type: 'reserve', account: 'a', amount: 999, reserveId: 'r', ok: false },
  ]);
  assert.equal(checkLinearizable(ops, { initial: { a: 10 } }).linearizable, true);
});

test('empty history is trivially linearizable', () => {
  const result = checkLinearizable([]);
  assert.equal(result.linearizable, true);
  assert.deepEqual(result.witness, []);
});
