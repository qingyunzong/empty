import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tmpdir, mulberry32, Model, randomChange, stateToComparable } from '../testlib/helpers.js';

// Random operation sequences checked against a reference model, including
// replay to random historical txns, checkpoints, reopen and audit.
for (const seed of [1, 2, 3]) {
  test(`random sequence vs reference model (seed ${seed})`, () => {
    const dir = tmpdir();
    const rand = mulberry32(seed);
    const keys = Array.from({ length: 40 }, (_, i) => `ch/${i}`);
    const devices = Array.from({ length: 5 }, (_, i) => `dev-${i}`);
    const model = new Model();
    let store = Store.open(dir);

    for (let i = 1; i <= 600; i++) {
      const change = randomChange(rand, keys, devices);
      store.apply(change);
      model.apply(change);

      if (i % 50 === 0) {
        // Live path must equal the model at every checkpoint of the loop.
        assert.deepEqual(stateToComparable(store.state), stateToComparable(model.at(i)), `live state at txn ${i}`);
        // Replay to a random historical txn must equal the model snapshot.
        const target = 1 + Math.floor(rand() * i);
        assert.deepEqual(
          stateToComparable(store.replay(target)),
          stateToComparable(model.at(target)),
          `replay to txn ${target}`,
        );
      }
      if (i === 300) store.checkpoint();
      if (i === 450) {
        store.close();
        store = Store.open(dir); // restart: live state rebuilt from WAL
        assert.deepEqual(stateToComparable(store.state), stateToComparable(model.at(i)));
      }
    }

    assert.deepEqual(stateToComparable(store.replay(600)), stateToComparable(model.at(600)));
    assert.equal(store.audit().ok, true);
    store.close();
  });
}
