import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { evaluateAll } from '../src/graph.js';
import { tmpdir } from './helpers.js';

function buildBase(store) {
  store.append('ADD_FACT', { id: 'f1', source: 's1', value: 2 });
  store.append('ADD_FACT', { id: 'f2', source: 's2', value: 3 });
  store.append('ADD_DERIVED', { id: 'd1', op: 'sum', min: 5, inputs: ['f1', 'f2'] });
  store.append('ADD_DERIVED', { id: 'd2', op: 'count', inputs: ['d1'] });
}

const EXPECTED = { f1: 'valid', f2: 'valid', d1: 'valid', d2: 'valid' };

test('acceptance 4 / FP1 afterAppend: crash after WAL append, before index update', () => {
  for (let run = 0; run < 2; run += 1) {
    const dir = tmpdir();
    const store = Store.open(dir);
    buildBase(store);
    store.faults.afterAppend = () => { throw new Error('crash@afterAppend'); };
    assert.throws(() => store.append('REVOKE_SOURCE', { id: 's2' }), /crash@afterAppend/);

    const recovered = Store.open(dir);
    // the appended event is durable in the WAL and must be replayed
    assert.equal(recovered.status('f2').status, 'revoked');
    assert.equal(recovered.status('d1').status, 'degraded');
    assert.equal(recovered.status('d2').status, 'degraded');
    assert.doesNotThrow(() => recovered.verify());
  }
});

test('acceptance 4 / FP2 beforeIndex: torn index checkpoint is rebuilt from WAL', () => {
  for (let run = 0; run < 2; run += 1) {
    const dir = tmpdir();
    const store = Store.open(dir);
    buildBase(store);
    store.faults.beforeIndex = () => {
      fs.writeFileSync(path.join(dir, 'index.json'), '{torn-index');
      throw new Error('crash@beforeIndex');
    };
    assert.throws(() => store.append('REVOKE_SOURCE', { id: 's2' }), /crash@beforeIndex/);

    const recovered = Store.open(dir);
    assert.equal(recovered.status('f2').status, 'revoked');
    assert.equal(recovered.status('d1').status, 'degraded');
    assert.doesNotThrow(() => recovered.verify());
  }
});

test('acceptance 4 / FP3 afterSnapshot: uncompacted WAL replays idempotently', () => {
  for (let run = 0; run < 2; run += 1) {
    const dir = tmpdir();
    const store = Store.open(dir);
    buildBase(store);
    store.faults.afterSnapshot = () => { throw new Error('crash@afterSnapshot'); };
    assert.throws(() => store.snapshot(), /crash@afterSnapshot/);
    // snapshot.json committed, WAL still holds all 4 events
    assert.ok(fs.existsSync(path.join(dir, 'snapshot.json')));
    const walLines = fs.readFileSync(path.join(dir, 'wal.log'), 'utf8').trim().split('\n');
    assert.equal(walLines.length, 4);

    const recovered = Store.open(dir);
    assert.deepEqual(evaluateAll(recovered.state), EXPECTED);
    assert.doesNotThrow(() => recovered.verify());

    // log stays consistent for events appended after recovery
    recovered.append('REVOKE_SOURCE', { id: 's1' });
    const again = Store.open(dir);
    assert.equal(again.status('f1').status, 'revoked');
    assert.equal(again.status('d1').status, 'degraded');
    assert.doesNotThrow(() => again.verify());
  }
});

test('acceptance 4: recovery result is deterministic across identical scenarios', () => {
  const runs = [];
  for (let run = 0; run < 2; run += 1) {
    const dir = tmpdir();
    const store = Store.open(dir);
    buildBase(store);
    store.faults.afterAppend = () => { throw new Error('crash'); };
    assert.throws(() => store.append('REVOKE_SOURCE', { id: 's2' }));
    const recovered = Store.open(dir);
    recovered.snapshot();
    const final = Store.open(dir);
    runs.push(evaluateAll(final.state));
  }
  assert.deepEqual(runs[0], runs[1]);
});

test('torn WAL tail is truncated during recovery', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  buildBase(store);
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"seq":5,"typ');
  const recovered = Store.open(dir);
  assert.deepEqual(evaluateAll(recovered.state), EXPECTED);
  assert.equal(recovered.lastSeq, 4);
  // subsequent appends reuse the truncated tail cleanly
  recovered.append('REVOKE_SOURCE', { id: 's1' });
  assert.equal(Store.open(dir).status('f1').status, 'revoked');
});
