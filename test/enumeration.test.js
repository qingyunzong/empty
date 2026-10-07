import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica } from '../src/replica.js';
import { canonical } from '../src/canonical.js';

// Per-record scripts over upsert (U), resolve (R), delete (D).
const SCRIPTS = [
  [],
  ['U'],
  ['U', 'R'],
  ['U', 'D'],
  ['U', 'R', 'D'],
  ['U', 'D', 'U'],
];

const RECORDS = ['r1', 'r2', 'r3'];

function assignments() {
  const out = [];
  for (let i = 0; i < SCRIPTS.length; i += 1) {
    for (let j = 0; j < SCRIPTS.length; j += 1) {
      for (let k = 0; k < SCRIPTS.length; k += 1) {
        out.push([SCRIPTS[i], SCRIPTS[j], SCRIPTS[k]]);
      }
    }
  }
  return out;
}

function applyScript(replica, script, id, amount) {
  for (const op of script) {
    if (op === 'U') replica.upsert(id, amount, amount);
    else if (op === 'R') replica.resolve(id);
    else replica.delete(id);
  }
}

// Anti-entropy: exchange state until quiescent. stale-resurrect rejections
// are expected on one direction; the other direction always heals.
function repair(a, b) {
  let staleSeen = 0;
  for (let round = 0; round < 6; round += 1) {
    for (const [dst, src] of [[a, b], [b, a]]) {
      const applied = dst.merge(src.state);
      staleSeen += applied.stale.length;
      for (const id of applied.stale) {
        // Rejected stale re-adds must never resurrect the record.
        assert.equal(dst.state.records[id], undefined);
        assert.ok(dst.state.tombstones[id]);
      }
    }
  }
  return staleSeen;
}

function assertConverged(a, b, context) {
  assert.equal(
    canonical(a.entries()),
    canonical(b.entries()),
    `entries diverged: ${context}`,
  );
  assert.equal(a.digest(), b.digest(), `digest diverged: ${context}`);
  assert.equal(a.epoch(), b.epoch(), `epoch diverged: ${context}`);
  assert.deepEqual(a.conflictList(), b.conflictList(), `conflicts diverged: ${context}`);
  assert.equal(
    a.snapshot().certificate.valid,
    b.snapshot().certificate.valid,
    `certificate validity diverged: ${context}`,
  );
}

test('exhaustive 3-record upsert/resolve/delete combinations converge (identical writes)', () => {
  const combos = assignments();
  let scenarios = 0;
  let staleScenarios = 0;
  let conflictScenarios = 0;
  for (const comboA of combos) {
    for (const comboB of combos) {
      const a = new Replica('a');
      const b = new Replica('b');
      RECORDS.forEach((id, idx) => {
        applyScript(a, comboA[idx], id, (idx + 1) * 100);
        applyScript(b, comboB[idx], id, (idx + 1) * 100);
      });
      const stale = repair(a, b);
      assertConverged(a, b, `A=${canonical(comboA)} B=${canonical(comboB)}`);
      scenarios += 1;
      if (stale > 0) staleScenarios += 1;
      if (a.conflictList().length > 0) conflictScenarios += 1;
    }
  }
  assert.equal(scenarios, combos.length * combos.length); // 216^2 = 46656
  // Both rejection and conflict paths must actually be exercised.
  assert.ok(staleScenarios > 0, 'stale-resurrect path never exercised');
  assert.ok(conflictScenarios > 0, 'conflict path never exercised');
});

test('exhaustive 3-record combinations converge (concurrent differing writes)', () => {
  const shortScripts = SCRIPTS.slice(0, 4); // 4^3 = 64 assignments per replica
  const combos = [];
  for (const i of shortScripts) {
    for (const j of shortScripts) {
      for (const k of shortScripts) combos.push([i, j, k]);
    }
  }
  for (const comboA of combos) {
    for (const comboB of combos) {
      const a = new Replica('a');
      const b = new Replica('b');
      RECORDS.forEach((id, idx) => {
        // Replica-dependent amounts force concurrent differing upserts,
        // exercising the deterministic last-writer resolution.
        applyScript(a, comboA[idx], id, (idx + 1) * 100);
        applyScript(b, comboB[idx], id, (idx + 1) * 100 + 7);
      });
      repair(a, b);
      assertConverged(a, b, `A=${canonical(comboA)} B=${canonical(comboB)}`);
    }
  }
});
