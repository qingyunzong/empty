import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVersion, buildConstraints } from '../src/checker.js';
import { referenceCheck } from '../src/reference.js';
import { compile, ev, prng, REGISTER_DSL, COMMUTE_RULE } from '../testkit/helpers.js';

const WITH_COMMUTES = compile(REGISTER_DSL + COMMUTE_RULE);
const WITHOUT_COMMUTES = compile(REGISTER_DSL);

function randomHistory(rand, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const invocation = Math.floor(rand() * 30);
    const response = invocation + 1 + Math.floor(rand() * 3);
    const op = rand() < 0.5 ? 'read' : 'write';
    const key = rand() < 0.5 ? 'x' : 'y';
    let value;
    const priorWrites = events.filter((e) => e.op === 'write' && e.key === key);
    if (op === 'read' && priorWrites.length > 0 && rand() < 0.6) {
      value = priorWrites[Math.floor(rand() * priorWrites.length)].value;
    } else {
      value = rand() < 0.15 ? null : Math.floor(rand() * 3);
    }
    let prev = null;
    if (i > 0 && rand() < 0.3) prev = `e${Math.floor(rand() * i)}`;
    events.push(ev(`e${i}`, {
      node: `n${i % 3}`, prev, invocation, response, realTime: invocation, op, key, value,
    }));
  }
  return events;
}

test('acceptance 5: main checker agrees with the full-permutation reference (<= 8 ops)', () => {
  const rand = prng(20261003);
  let linearizable = 0;
  let nonLinearizable = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 operations
    const events = randomHistory(rand, n);
    const compiled = rand() < 0.5 ? WITH_COMMUTES : WITHOUT_COMMUTES;
    const main = checkVersion(events, compiled);
    assert.notEqual(main.verdict, 'UNKNOWN', 'completed histories must never be UNKNOWN');
    const sorted = events.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const { edges, commutePairs } = buildConstraints(sorted, compiled);
    const ref = referenceCheck(sorted, edges, commutePairs, compiled.effects);
    assert.equal(
      main.verdict, ref.verdict,
      `disagreement on trial ${trial}: main=${main.verdict} ref=${ref.verdict} events=${JSON.stringify(events)}`);
    if (main.verdict === 'LINEARIZABLE') linearizable++;
    else nonLinearizable++;
  }
  // The corpus must exercise both outcomes to be meaningful.
  assert.ok(linearizable > 20, `too few linearizable cases: ${linearizable}`);
  assert.ok(nonLinearizable > 50, `too few non-linearizable cases: ${nonLinearizable}`);
});

// Sequential, well-behaved histories: non-overlapping intervals, reads
// usually observe the most recent write. Mostly LINEARIZABLE.
function sequentialHistory(rand, n) {
  const events = [];
  const state = new Map();
  for (let i = 0; i < n; i++) {
    const invocation = i * 10;
    const response = invocation + 5;
    const key = rand() < 0.5 ? 'x' : 'y';
    const op = rand() < 0.5 ? 'read' : 'write';
    let value;
    if (op === 'write') {
      value = Math.floor(rand() * 3);
      state.set(key, value);
    } else {
      if (state.has(key)) {
        value = rand() < 0.85 ? state.get(key) : Math.floor(rand() * 3);
      } else {
        value = rand() < 0.85 ? null : Math.floor(rand() * 3);
      }
    }
    events.push(ev(`e${i}`, {
      node: `n${i % 3}`, invocation, response, realTime: invocation, op, key, value,
    }));
  }
  return events;
}

test('acceptance 5 (sequential corpus): agreement on mostly-linearizable histories', () => {
  const rand = prng(777);
  let linearizable = 0;
  for (let trial = 0; trial < 150; trial++) {
    const n = 2 + Math.floor(rand() * 7);
    const events = sequentialHistory(rand, n);
    const compiled = rand() < 0.5 ? WITH_COMMUTES : WITHOUT_COMMUTES;
    const main = checkVersion(events, compiled);
    const sorted = events.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const { edges, commutePairs } = buildConstraints(sorted, compiled);
    const ref = referenceCheck(sorted, edges, commutePairs, compiled.effects);
    assert.equal(main.verdict, ref.verdict,
      `disagreement on trial ${trial}: main=${main.verdict} ref=${ref.verdict}`);
    if (main.verdict === 'LINEARIZABLE') linearizable++;
  }
  assert.ok(linearizable > 50, `too few linearizable cases: ${linearizable}`);
});

test('reference: cycle means no permutation satisfies the edges', () => {
  const compiled = WITHOUT_COMMUTES;
  const events = [
    ev('e1', { prev: 'e2', invocation: 1, response: 2 }),
    ev('e2', { invocation: 3, response: 4 }),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  const { edges, commutePairs } = buildConstraints(events, compiled);
  assert.equal(referenceCheck(events, edges, commutePairs, compiled.effects).verdict, 'NON_LINEARIZABLE');
});
