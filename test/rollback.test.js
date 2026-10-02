import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSchema, ParamStore, RollbackEngine, CertStore, RollbackError } from '../src/index.js';

const schema = compileSchema([
  { key: 'temp', type: 'number', min: 0, max: 100, safety: true },
  { key: 'mode', type: 'string' },
]);

function setup() {
  const store = new ParamStore(schema, 'eng');
  store.set('temp', 70);
  store.lock('temp');
  const certs = new CertStore();
  certs.issue('c1', 'operator-a');
  return { store, certs };
}

test('rollback hierarchy: unlock -> revert -> cert-clear succeeds in order', () => {
  const { store, certs } = setup();
  const target = store.snapshot();
  target.params.temp.value = 0;
  const engine = new RollbackEngine(store, certs);
  const result = engine.runAll(target);
  assert.deepEqual(result.unlocked, ['temp']);
  assert.deepEqual(result.reverted, ['temp']);
  assert.equal(result.certsCleared, 1);
  assert.equal(store.get('temp'), 0);
  assert.equal(store.isLocked('temp'), false);
  assert.equal(certs.list().length, 0);
});

test('revert before unlock is a ROLLBACK error', () => {
  const { store, certs } = setup();
  const engine = new RollbackEngine(store, certs);
  assert.throws(() => engine.revert(store.snapshot()), (e) => e instanceof RollbackError && e.code === 'ROLLBACK');
});

test('cert-clear before revert is a ROLLBACK error', () => {
  const { store, certs } = setup();
  const engine = new RollbackEngine(store, certs);
  assert.throws(() => engine.certClear(), (e) => e.code === 'ROLLBACK');
  engine.unlock();
  assert.throws(() => engine.certClear(), (e) => e.code === 'ROLLBACK');
  // engine still usable after failed attempts: correct order resumes
  engine.revert(store.snapshot());
  engine.certClear();
  assert.deepEqual(engine.done, ['unlock', 'revert', 'cert-clear']);
});

test('cert store duplicate issue and missing revoke are ROLLBACK errors', () => {
  const cs = new CertStore();
  cs.issue('x', 's');
  assert.throws(() => cs.issue('x', 's'), (e) => e.code === 'ROLLBACK');
  assert.throws(() => cs.revoke('ghost'), (e) => e.code === 'ROLLBACK');
});
