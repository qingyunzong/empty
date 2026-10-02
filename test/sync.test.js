import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSchema, ParamStore, mergeSnapshots, vvCompare } from '../src/index.js';

const schema = compileSchema([
  { key: 'temp', type: 'number', min: 0, max: 100, safety: true },
  { key: 'mode', type: 'string' },
]);

function snap(nodeId, fn) {
  const s = new ParamStore(schema, nodeId);
  fn(s);
  return s.snapshot();
}

test('version vector compare: gt/lt/eq/concurrent', () => {
  assert.equal(vvCompare({ a: 1 }, { a: 1 }), 'eq');
  assert.equal(vvCompare({ a: 2 }, { a: 1 }), 'gt');
  assert.equal(vvCompare({ a: 1 }, { a: 1, b: 1 }), 'lt');
  assert.equal(vvCompare({ a: 2 }, { b: 1 }), 'concurrent');
});

test('dominant side wins, merged vv is element-wise max', () => {
  const a = snap('eng', (s) => { s.set('mode', 'a1'); s.set('mode', 'a2'); });
  const b = snap('fb', (s) => s.set('mode', 'b1'));
  // b is a stale replica that only saw a's first edit and never wrote itself
  b.params.mode.vv = { eng: 1 };
  b.params.mode.value = 'a1';
  const { merged, pending } = mergeSnapshots(schema, a, b);
  assert.equal(pending.length, 0);
  assert.equal(merged.params.mode.value, 'a2');
  assert.deepEqual(merged.params.mode.vv, { eng: 2 });
});

test('concurrent non-safety conflict resolves deterministically', () => {
  const a = snap('eng', (s) => s.set('mode', 'from-eng'));
  const b = snap('fb', (s) => s.set('mode', 'from-fb'));
  const r1 = mergeSnapshots(schema, a, b);
  const r2 = mergeSnapshots(schema, b, a); // order must not matter
  assert.equal(r1.pending.length, 0);
  assert.equal(r1.merged.params.mode.value, r2.merged.params.mode.value);
  assert.deepEqual(r1.merged.params.mode.vv, { eng: 1, fb: 1 });
});

test('safety-critical concurrent conflict must be pending, never auto-resolved', () => {
  const a = snap('eng', (s) => s.set('temp', 40));
  const b = snap('fb', (s) => s.set('temp', 60));
  const { merged, pending } = mergeSnapshots(schema, a, b);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].key, 'temp');
  assert.equal(merged.params.temp.value, 40, 'local value kept while pending');
  assert.deepEqual(merged.params.temp.vv, { eng: 1 }, 'vv not merged while pending');
});

test('safety-critical dominant update merges without pending', () => {
  const a = snap('eng', (s) => { s.set('temp', 40); s.set('temp', 41); });
  const b = snap('fb', (s) => s.set('temp', 60));
  b.params.temp.vv = { eng: 1 }; // stale replica of a's first edit; a dominates
  b.params.temp.value = 40;
  const { merged, pending } = mergeSnapshots(schema, a, b);
  assert.equal(pending.length, 0);
  assert.equal(merged.params.temp.value, 41);
});
