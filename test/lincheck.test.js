import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLinearizable, LinError } from '../src/lincheck.js';
import { mulberry32, genHistory, bruteForceLinearizable } from '../testutil/util.mjs';

// Acceptance 2: for acyclic histories the checker must agree with serial
// enumeration of all topological orders; and it must scale to 100 events.
test('lincheck agrees with brute-force topological-order enumeration', () => {
  const rng = mulberry32(42);
  let linearizableCount = 0;
  let nonLinearizableCount = 0;
  for (let trial = 0; trial < 300; trial++) {
    const corrupt = trial % 2 === 1;
    const log = genHistory(rng, {
      procs: 2 + Math.floor(rng() * 2),
      perProc: 1 + Math.floor(rng() * 3),
      reads: 1 + Math.floor(rng() * 2),
      corrupt,
    });
    const expected = bruteForceLinearizable(log);
    const res = checkLinearizable(log);
    assert.equal(
      res.linearizable,
      expected,
      `trial ${trial}: checker=${res.linearizable} brute=${expected}`
    );
    if (res.linearizable) linearizableCount++;
    else {
      nonLinearizableCount++;
      assert.equal(res.code, 'E_NONLINEAR');
    }
  }
  assert.ok(linearizableCount > 0, 'need positive cases');
  assert.ok(nonLinearizableCount > 0, 'need negative cases');
});

test('lincheck handles a 100-event acyclic history', () => {
  // 4 processes x 24 commits in a causal grid (each commit depends on its
  // process predecessor and the previous process's commit in the same round)
  // = 96 commits + 4 reads = 100 events; concurrent within each round.
  const events = [];
  let vc = 0;
  const ids = [];
  for (let p = 0; p < 4; p++) {
    ids.push([]);
    for (let i = 1; i <= 24; i++) {
      const deps = [];
      if (i > 1) deps.push(ids[p][i - 2]);
      if (p > 0) deps.push(ids[p - 1][i - 1]);
      const id = `p${p}c${i}`;
      ids[p].push(id);
      events.push({
        type: 'commit',
        id,
        processId: `p${p}`,
        clock: i,
        deps,
        ops: [{ op: 'assert', key: `k${(p * 24 + i) % 7}`, value: `v${vc++}` }],
      });
    }
  }
  // reads observe real prefixes of the round-robin serial order
  const serial = [];
  for (let i = 0; i < 24; i++) for (let p = 0; p < 4; p++) serial.push(ids[p][i]);
  const byId = new Map(events.map((e) => [e.id, e]));
  for (let r = 0; r < 4; r++) {
    const cut = serial.slice(0, (r + 1) * 24);
    const state = {};
    for (const id of cut) {
      for (const op of byId.get(id).ops) {
        if (op.op === 'assert') state[op.key] = op.value;
        else delete state[op.key];
      }
    }
    events.push({
      type: 'read',
      id: `r${r}`,
      processId: `pr${r}`,
      clock: 1,
      deps: [cut[cut.length - 1]],
      view: state,
    });
  }
  assert.equal(events.length, 100);
  const t0 = Date.now();
  const res = checkLinearizable({ events });
  const elapsed = Date.now() - t0;
  assert.equal(res.linearizable, true);
  assert.equal(res.order.length, 96);
  assert.ok(elapsed < 20000, `took ${elapsed}ms`);

  // corrupt one read with a never-asserted value -> E_NONLINEAR
  const corrupted = structuredClone(events);
  const lastRead = corrupted.find((e) => e.id === 'r3');
  lastRead.view.k0 = 'never-asserted';
  const bad = checkLinearizable({ events: corrupted });
  assert.equal(bad.linearizable, false);
  assert.equal(bad.code, 'E_NONLINEAR');
});

test('lincheck reports E_ORPHAN for unknown deps and detects hb cycles', () => {
  let orphan = null;
  try {
    checkLinearizable({ events: [
      { type: 'commit', id: 'a', processId: 'p', clock: 1, deps: ['ghost'], ops: [] },
    ] });
  } catch (e) {
    orphan = e;
  }
  assert.ok(orphan instanceof LinError);
  assert.equal(orphan.code, 'E_ORPHAN');

  const cyc = checkLinearizable({ events: [
    { type: 'commit', id: 'a', processId: 'p', clock: 1, deps: ['b'], ops: [] },
    { type: 'commit', id: 'b', processId: 'q', clock: 1, deps: ['a'], ops: [] },
  ] });
  assert.equal(cyc.linearizable, false);
  assert.equal(cyc.code, 'E_NONLINEAR');
  assert.match(cyc.reason, /cycle/);
});
