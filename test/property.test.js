import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { fullRecompute, invalidationClosure, applyOpsToDeclarations } from '../test-utils/reference.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INPUTS = ['i0', 'i1', 'i2'];
const VERSIONS = ['m0', 'm1'];

function randomGraph(rand, n) {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    const deps = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < 0.35) deps.push(`t${j}`);
    }
    tasks.push({
      id: `t${i}`,
      inputHash: INPUTS[Math.floor(rand() * INPUTS.length)],
      moduleVersion: VERSIONS[Math.floor(rand() * VERSIONS.length)],
      deps,
    });
  }
  return tasks;
}

function randomTransaction(rand, n) {
  const ops = [];
  const opCount = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < opCount; k += 1) {
    const task = `t${Math.floor(rand() * n)}`;
    switch (Math.floor(rand() * 4)) {
      case 0:
        ops.push({ type: 'setInput', task, inputHash: INPUTS[Math.floor(rand() * INPUTS.length)] });
        break;
      case 1:
        ops.push({ type: 'setModuleVersion', task, moduleVersion: VERSIONS[Math.floor(rand() * VERSIONS.length)] });
        break;
      case 2: {
        if (n < 2) {
          ops.push({ type: 'setInput', task, inputHash: INPUTS[Math.floor(rand() * INPUTS.length)] });
          break;
        }
        // Only ever add edges from higher to lower index: stays acyclic.
        const i = 1 + Math.floor(rand() * (n - 1));
        ops.push({ type: 'addDep', task: `t${i}`, dep: `t${Math.floor(rand() * i)}` });
        break;
      }
      default: {
        const i = Math.floor(rand() * n);
        ops.push({ type: 'removeDep', task: `t${i}`, dep: `t${Math.floor(rand() * n)}` });
        break;
      }
    }
  }
  // Budget ranges from 0 to n+2 so E_BUDGET is exercised regularly.
  return { maxRecompute: Math.floor(rand() * (n + 3)), ops };
}

function declarationsOf(store) {
  return new Map(
    [...store.tasks].map(([id, t]) => [
      id,
      { inputHash: t.inputHash, moduleVersion: t.moduleVersion, deps: [...t.deps].sort() },
    ]),
  );
}

function hashesOf(store) {
  return new Map([...store.tasks].map(([id, t]) => [id, t.resultHash]));
}

test('acceptance 1: incremental results match full-clear recompute (<=9 tasks, 400 seeds)', () => {
  let budgetCases = 0;
  let appliedCases = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const rand = mulberry32(seed);
    const n = 1 + Math.floor(rand() * 9);
    const store = new Store();
    assert.equal(store.loadTasks(randomGraph(rand, n)).ok, true, `seed ${seed} load`);

    const beforeDecls = declarationsOf(store);
    const beforeHashes = hashesOf(store);
    const tx = randomTransaction(rand, n);
    const afterDecls = applyOpsToDeclarations(beforeDecls, tx.ops);
    const referenceClosure = invalidationClosure(beforeDecls, afterDecls);

    const result = store.applyTransaction(tx);

    if (referenceClosure.size > tx.maxRecompute) {
      budgetCases += 1;
      assert.equal(result.ok, false, `seed ${seed} should exceed budget`);
      assert.equal(result.error.code, 'E_BUDGET', `seed ${seed}`);
      assert.equal(result.error.required, referenceClosure.size, `seed ${seed}`);
      assert.deepEqual(hashesOf(store), beforeHashes, `seed ${seed} rolled back`);
      assert.deepEqual(declarationsOf(store), beforeDecls, `seed ${seed} declarations rolled back`);
    } else {
      appliedCases += 1;
      assert.equal(result.ok, true, `seed ${seed} should apply`);
      assert.deepEqual(
        [...result.invalidated].sort(),
        [...referenceClosure].sort(),
        `seed ${seed} invalidation set matches reference`,
      );
      const referenceHashes = fullRecompute(afterDecls);
      assert.deepEqual(hashesOf(store), referenceHashes, `seed ${seed} hashes match full recompute`);
      // Stop points are exactly the recomputed tasks whose hash did not move.
      const expectedStops = result.changes.filter((c) => c.oldHash === c.newHash).map((c) => c.id);
      assert.deepEqual(result.stopPoints, expectedStops, `seed ${seed} stop points`);
    }
  }
  assert.ok(budgetCases > 20, `budget path exercised (${budgetCases} cases)`);
  assert.ok(appliedCases > 100, `apply path exercised (${appliedCases} cases)`);
});
