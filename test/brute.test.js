import test from 'node:test';
import assert from 'node:assert/strict';
import { findWitnesses } from '../src/checker.js';
import { bruteForceWitnesses, verifyWitness } from '../src/brute.js';
import { createState, step, auditValues } from '../src/model.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a plausible history by simulating a random sequential execution,
// then assign small overlapping invoke/respond intervals. With probability
// `corrupt`, tamper with one response to create conflicts.
function randomHistory(rng, corrupt) {
  const opCount = 2 + Math.floor(rng() * 5); // 2..6 operations
  const ops = [];
  let state = createState();
  const holdIds = [];
  let clock = 0;
  for (let i = 0; i < opCount; i += 1) {
    clock += 1;
    const kinds = ['hold'];
    if (holdIds.length > 0) kinds.push('capture', 'capture', 'cancel', 'audit', 'audit');
    const kind = kinds[Math.floor(rng() * kinds.length)];
    const id = `op${i}`;
    if (kind === 'hold') {
      const amount = 20 + Math.floor(rng() * 8) * 10;
      const op = { id, op: 'hold', clock, version: 1, amount, deadline: 1000,
        response: { ok: true, holdId: `H${i}` } };
      state = step(state, op, 0).state;
      holdIds.push(`H${i}`);
      ops.push(op);
    } else {
      const holdId = holdIds[Math.floor(rng() * holdIds.length)];
      const hold = state.holds.get(holdId);
      if (kind === 'capture') {
        const amount = 1 + Math.floor(rng() * 60);
        const ok = hold.active && amount <= hold.amount - hold.captured;
        const response = ok
          ? { ok: true, totalCaptured: hold.captured + amount }
          : { ok: false, error: hold.active ? 'insufficient' : 'cancelled' };
        const op = { id, op: 'capture', holdId, clock, version: 1, amount, response };
        const result = step(state, op, 0);
        if (result) state = result.state;
        ops.push(op);
      } else if (kind === 'cancel') {
        const response = hold.active
          ? { ok: true, released: hold.amount - hold.captured }
          : { ok: false, error: 'cancelled' };
        const op = { id, op: 'cancel', holdId, clock, version: 1, response };
        const result = step(state, op, 0);
        if (result) state = result.state;
        ops.push(op);
      } else {
        const values = auditValues(hold);
        ops.push({ id, op: 'audit', holdId, clock, version: 1, response: { ok: true, ...values } });
      }
    }
  }
  // Assign overlapping intervals in simulation order.
  let time = 0;
  for (const op of ops) {
    time += Math.floor(rng() * 3);
    op.invoke = time;
    op.respond = time + 1 + Math.floor(rng() * 4);
  }
  if (corrupt && ops.length > 0) {
    const victim = ops[Math.floor(rng() * ops.length)];
    if (victim.op === 'audit' && victim.response.ok) {
      victim.response.captured += 1 + Math.floor(rng() * 20);
    } else if (victim.op === 'capture' && victim.response.ok) {
      victim.response.totalCaptured += 1 + Math.floor(rng() * 20);
    } else if (victim.op === 'cancel' && victim.response.ok) {
      victim.response.released += 1 + Math.floor(rng() * 20);
    } else if (victim.op === 'hold') {
      victim.amount += 1 + Math.floor(rng() * 20);
    }
  }
  return ops;
}

test('main checker agrees with the independent brute-force enumerator', () => {
  let linearizableCount = 0;
  let conflictCount = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const rng = mulberry32(seed);
    const ops = randomHistory(rng, seed % 2 === 0);
    assert.ok(ops.length <= 6);
    const [witness] = findWitnesses(ops, { limit: 1 });
    const brute = bruteForceWitnesses(ops, { limit: 1 });
    assert.equal(
      witness !== undefined,
      brute.length > 0,
      `verdict mismatch for seed ${seed}: ${JSON.stringify(ops)}`,
    );
    if (witness) {
      linearizableCount += 1;
      assert.ok(verifyWitness(ops, witness), `invalid witness for seed ${seed}`);
      assert.ok(verifyWitness(ops, brute[0]), `invalid brute witness for seed ${seed}`);
    } else {
      conflictCount += 1;
    }
  }
  assert.ok(linearizableCount > 20, `too few linearizable samples: ${linearizableCount}`);
  assert.ok(conflictCount > 20, `too few conflicting samples: ${conflictCount}`);
});

test('witness counts agree exhaustively on small histories', () => {
  for (let seed = 1000; seed < 1040; seed += 1) {
    const rng = mulberry32(seed);
    const ops = randomHistory(rng, seed % 3 === 0).slice(0, 5);
    const mainAll = findWitnesses(ops, { limit: Infinity });
    const bruteAll = bruteForceWitnesses(ops, { limit: Infinity });
    assert.equal(mainAll.length, bruteAll.length, `witness count mismatch for seed ${seed}`);
    for (const witness of mainAll) assert.ok(verifyWitness(ops, witness));
  }
});
