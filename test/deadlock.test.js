'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  QuotaEngine,
  LockManager,
  E_DEADLOCK,
  E_LOCK_TIMEOUT,
} = require('../src');

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const result = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) {
      result.push([items[i], ...perm]);
    }
  }
  return result;
}

// Acceptance 1: two transactions freeze A/B in opposite orders. Each
// transaction runs its two freezes as a sequential program; we enumerate
// every interleaving of the two programs. Genuine interleavings must
// resolve with exactly one E_DEADLOCK (smallest txn id is the victim) and
// one survivor; fully serialized schedules end in E_LOCK_TIMEOUT instead.
// No schedule may wait forever.
function interleavings() {
  // T1 program: a1 = freeze A, a2 = freeze B. T2 program: b1 = freeze B,
  // b2 = freeze A. Program order must be preserved within each txn.
  const result = [];
  const steps = ['a1', 'a2', 'b1', 'b2'];
  for (const perm of permutations(steps)) {
    if (perm.indexOf('a1') < perm.indexOf('a2') && perm.indexOf('b1') < perm.indexOf('b2')) {
      result.push(perm);
    }
  }
  return result;
}

test('opposite-order A/B freezes: every interleaving yields one success and one E_DEADLOCK', async () => {
  const perms = interleavings();
  assert.equal(perms.length, 6);
  let deadlockSchedules = 0;
  let serializedSchedules = 0;
  for (const perm of perms) {
    const engine = QuotaEngine.open({ lockTimeoutMs: 200 });
    engine.addAccount('A', 1000, 1);
    engine.addAccount('B', 1000, 1);
    const t1 = engine.begin();
    const t2 = engine.begin();

    // Gates let the driver release one program step at a time, in the
    // order given by the permutation.
    const gates = new Map();
    for (const step of ['a1', 'a2', 'b1', 'b2']) {
      let open;
      gates.set(step, { promise: new Promise((resolve) => (open = resolve)), open });
    }
    const runStep = async (step, fn) => {
      await gates.get(step).promise;
      try {
        await fn();
        return { step, status: 'ok' };
      } catch (err) {
        return { step, status: err.code };
      }
    };
    const t1Program = (async () => [
      await runStep('a1', () => engine.freeze(t1, 'A', 100)),
      await runStep('a2', () => engine.freeze(t1, 'B', 100)),
    ])();
    const t2Program = (async () => [
      await runStep('b1', () => engine.freeze(t2, 'B', 100)),
      await runStep('b2', () => engine.freeze(t2, 'A', 100)),
    ])();

    const started = Date.now();
    for (const step of perm) {
      gates.get(step).open();
      // Let the released step run up to its lock wait.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = (await Promise.all([t1Program, t2Program])).flat();
    const elapsed = Date.now() - started;
    const count = (status) => results.filter((r) => r.status === status).length;
    const describe = `perm ${perm}: ${JSON.stringify(results)}`;

    // No schedule may wait forever.
    assert.ok(elapsed < 2000, `${describe} took ${elapsed}ms`);

    const serialized =
      perm.join(',').startsWith('a1,a2') || perm.join(',').startsWith('b1,b2');
    if (serialized) {
      serializedSchedules++;
      assert.equal(count(E_DEADLOCK), 0, `serialized, no deadlock: ${describe}`);
      assert.ok(count(E_LOCK_TIMEOUT) >= 1, `expected a timeout: ${describe}`);
      const winner = perm[0] === 'a1' ? t1 : t2;
      assert.equal(engine.transactions.get(winner).state, 'active', describe);
      await engine.commit(winner);
    } else {
      deadlockSchedules++;
      assert.equal(count(E_DEADLOCK), 1, `expected one E_DEADLOCK: ${describe}`);
      assert.equal(count('ok'), 3, `expected three successes: ${describe}`);
      // The victim is always the smallest txn id (T1); T2 survives.
      assert.equal(engine.transactions.get(t1).state, 'aborted', describe);
      assert.equal(engine.transactions.get(t2).state, 'active', describe);
      const committed = await engine.commit(t2);
      assert.equal(committed.items.length, 2);
      assert.equal(engine.availableOf('A'), 900);
      assert.equal(engine.availableOf('B'), 900);
    }
    engine.close();
  }
  assert.equal(deadlockSchedules, 4);
  assert.equal(serializedSchedules, 2);
});

test('live concurrent deadlock: victim is the smallest txn id', async () => {
  const engine = QuotaEngine.open({ lockTimeoutMs: 200 });
  engine.addAccount('A', 1000, 1);
  engine.addAccount('B', 1000, 1);
  const t1 = engine.begin();
  const t2 = engine.begin();
  await engine.freeze(t1, 'A', 100);
  await engine.freeze(t2, 'B', 100);
  const settled = await Promise.allSettled([
    engine.freeze(t1, 'B', 100),
    engine.freeze(t2, 'A', 100),
  ]);
  const rejected = settled.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, E_DEADLOCK);
  // T1 (smallest id) is the victim; T2 survives and commits.
  assert.equal(engine.transactions.get(t1).state, 'aborted');
  assert.equal(engine.transactions.get(t2).state, 'active');
  await engine.commit(t2);
  assert.equal(engine.availableOf('A'), 900);
  assert.equal(engine.availableOf('B'), 900);
  engine.close();
});

// Reference: enumerate cycles in a small hand-built waits-for graph.
test('waits-for graph cycle enumeration finds elementary cycles', () => {
  const lm = new LockManager();
  lm.acquireSync(3, 'a');
  lm.acquireSync(1, 'b');
  lm.acquireSync(2, 'c');
  // 3 -> 1 -> 2 -> 3 forms a cycle; victim must be txn 1.
  const graph = lm.buildWaitsForGraph([
    [3, 1],
    [1, 2],
    [2, 3],
  ]);
  const cycles = LockManager.enumerateCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(Math.min(...cycles[0]), 1);

  // Acyclic graphs report no cycles.
  const dag = lm.buildWaitsForGraph([[3, 1], [1, 2]]);
  assert.equal(LockManager.enumerateCycles(dag).length, 0);

  // Two independent cycles are both enumerated.
  const two = new Map([
    [1, new Set([2])],
    [2, new Set([1])],
    [3, new Set([4])],
    [4, new Set([3])],
  ]);
  assert.equal(LockManager.enumerateCycles(two).length, 2);
});
