import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkLinearizability } from '../src/checker.js';

function load(name) {
  return JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
}

test('overlapping reads may observe old and new values; witness is produced', () => {
  const history = load('overlapping-reads.json');
  const result = checkLinearizability(history, { initialBalance: 100 });
  assert.equal(result.linearizable, true);
  assert.equal(result.witness.length, 3);
  // read-old must be ordered before the reserve, read-new after it
  const order = result.order;
  assert.ok(order.indexOf('read-old') < order.indexOf('res1'));
  assert.ok(order.indexOf('res1') < order.indexOf('read-new'));
  // every linearization point lies within its operation's [invocation, response]
  for (const w of result.witness) {
    const op = history.find((o) => o.opId === w.opId);
    assert.ok(w.linearizationPoint >= op.invocationTime, `${w.opId} point >= invocation`);
    assert.ok(w.linearizationPoint <= op.responseTime, `${w.opId} point <= response`);
  }
  // points are non-decreasing along the witness order
  for (let i = 1; i < result.witness.length; i++) {
    assert.ok(result.witness[i].linearizationPoint >= result.witness[i - 1].linearizationPoint);
  }
  console.log(`WITNESS overlapping-reads: ${JSON.stringify(result.order)} points=${result.witness.map((w) => w.linearizationPoint).join(',')}`);
});

test('a single overlapping read may legitimately see the OLD value', () => {
  const history = [
    { client: 'c1', opId: 'res', invocationTime: 2, responseTime: 8, type: 'reserve', account: 'a', amount: 10, reserveId: 'r1', status: 'ok' },
    { client: 'c2', opId: 'rd', invocationTime: 3, responseTime: 7, type: 'read', account: 'a', balance: 100, frozen: 0 },
  ];
  assert.equal(checkLinearizability(history, { initialBalance: 100 }).linearizable, true);
});

test('a single overlapping read may legitimately see the NEW value', () => {
  const history = [
    { client: 'c1', opId: 'res', invocationTime: 2, responseTime: 8, type: 'reserve', account: 'a', amount: 10, reserveId: 'r1', status: 'ok' },
    { client: 'c2', opId: 'rd', invocationTime: 3, responseTime: 7, type: 'read', account: 'a', balance: 90, frozen: 10 },
  ];
  assert.equal(checkLinearizability(history, { initialBalance: 100 }).linearizable, true);
});

test('an overlapping read can NEVER see a torn/impossible value', () => {
  const history = [
    { client: 'c1', opId: 'res', invocationTime: 2, responseTime: 8, type: 'reserve', account: 'a', amount: 10, reserveId: 'r1', status: 'ok' },
    { client: 'c2', opId: 'rd', invocationTime: 3, responseTime: 7, type: 'read', account: 'a', balance: 95, frozen: 5 },
  ];
  const result = checkLinearizability(history, { initialBalance: 100 });
  assert.equal(result.linearizable, false);
  assert.match(result.reason, /no sequential ordering/);
});

test('commit succeeding after a completed cancel is NOT linearizable', () => {
  const history = load('cancel-then-commit.json');
  const result = checkLinearizability(history, { initialBalance: 100 });
  assert.equal(result.linearizable, false);
  console.log(`CONFLICT cancel-then-commit: ${result.reason}`);
});

test('commit after cancel IS linearizable when commit fails', () => {
  const history = load('cancel-then-commit.json');
  history[2].status = 'fail';
  assert.equal(checkLinearizability(history, { initialBalance: 100 }).linearizable, true);
});

test('zero amount full cycle is linearizable and reads observe no drift', () => {
  const history = load('zero-amount-cycle.json');
  const result = checkLinearizability(history, { initialBalance: 100 });
  assert.equal(result.linearizable, true);
  console.log(`WITNESS zero-amount-cycle: ${JSON.stringify(result.order)}`);
});

test('unknown reserveId commit must be recorded as fail', () => {
  const okHistory = [
    { client: 'c1', opId: 'c1', invocationTime: 0, responseTime: 1, type: 'commit', account: 'a', reserveId: 'ghost', status: 'ok' },
  ];
  assert.equal(checkLinearizability(okHistory).linearizable, false);
  const failHistory = [{ ...okHistory[0], status: 'fail' }];
  assert.equal(checkLinearizability(failHistory).linearizable, true);
});

test('double successful commit of the same reservation is impossible', () => {
  const history = [
    { client: 'c1', opId: 'res', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 5, reserveId: 'r1', status: 'ok' },
    { client: 'c1', opId: 'com1', invocationTime: 2, responseTime: 3, type: 'commit', account: 'a', reserveId: 'r1', status: 'ok' },
    { client: 'c2', opId: 'com2', invocationTime: 2, responseTime: 3, type: 'commit', account: 'a', reserveId: 'r1', status: 'ok' },
  ];
  assert.equal(checkLinearizability(history, { initialBalance: 100 }).linearizable, false);
  history[2].status = 'fail';
  assert.equal(checkLinearizability(history, { initialBalance: 100 }).linearizable, true);
});

test('real-time order is enforced: read after completed reserve must see the hold', () => {
  const history = [
    { client: 'c1', opId: 'res', invocationTime: 0, responseTime: 2, type: 'reserve', account: 'a', amount: 10, reserveId: 'r1', status: 'ok' },
    { client: 'c2', opId: 'rd', invocationTime: 3, responseTime: 4, type: 'read', account: 'a', balance: 100, frozen: 0 },
  ];
  assert.equal(checkLinearizability(history, { initialBalance: 100 }).linearizable, false);
});

test('empty history is trivially linearizable', () => {
  const result = checkLinearizability([]);
  assert.equal(result.linearizable, true);
  assert.deepEqual(result.order, []);
});
