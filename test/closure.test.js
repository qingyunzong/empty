import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { evaluateAll } from '../src/graph.js';
import { tmpdir, mulberry32, randomScenario, referenceEvaluateAll } from './helpers.js';

test('acceptance 3: <=100-node random graphs match reference closure enumeration', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const rand = mulberry32(seed);
    const { commands, nodeIds } = randomScenario(rand, 100);
    assert.ok(nodeIds.length <= 100);
    const dir = tmpdir();
    const store = Store.open(dir);
    for (const [type, payload] of commands) store.append(type, payload);

    const expected = referenceEvaluateAll(store.state);
    const actual = evaluateAll(store.state);
    assert.deepEqual(actual, expected, `seed ${seed}: in-memory evaluation mismatch`);

    // same result after WAL replay from disk
    const reopened = Store.open(dir);
    assert.deepEqual(evaluateAll(reopened.state), expected, `seed ${seed}: replay mismatch`);

    // same result after snapshot + compaction + replay
    store.snapshot();
    const afterSnap = Store.open(dir);
    assert.deepEqual(evaluateAll(afterSnap.state), expected, `seed ${seed}: snapshot mismatch`);
  }
});
