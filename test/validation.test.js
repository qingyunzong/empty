import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSchema, ParamStore, ValidationError } from '../src/index.js';

const schema = compileSchema([
  { key: 'temp', type: 'number', min: 0, max: 100, safety: true },
  { key: 'heater', type: 'boolean', interlock: 'heater == false || temp < 80' },
  { key: 'mode', type: 'string' },
]);

test('set captures change and bumps version vector', () => {
  const s = new ParamStore(schema, 'eng');
  const d = s.set('temp', 42);
  assert.equal(s.get('temp'), 42);
  assert.equal(d.op, 'set');
  assert.deepEqual(d.vv, { eng: 1 });
  assert.equal(s.deltas.length, 1);
});

test('out-of-range value is rejected with VALIDATION', () => {
  const s = new ParamStore(schema, 'eng');
  assert.throws(() => s.set('temp', 101), (e) => e instanceof ValidationError && e.code === 'VALIDATION');
  assert.throws(() => s.set('temp', -1), ValidationError);
  assert.equal(s.get('temp'), 0); // unchanged
});

test('wrong type is rejected with VALIDATION', () => {
  const s = new ParamStore(schema, 'eng');
  assert.throws(() => s.set('temp', 'hot'), ValidationError);
  assert.throws(() => s.set('heater', 1), ValidationError);
  assert.throws(() => s.set('mode', 3), ValidationError);
  assert.throws(() => s.set('temp', NaN), ValidationError);
});

test('interlock violation is rejected with VALIDATION', () => {
  const s = new ParamStore(schema, 'eng');
  s.set('temp', 90);
  assert.throws(() => s.set('heater', true), (e) => e.code === 'VALIDATION' && /interlock/.test(e.message));
  // legal path: heater on while temp low
  const s2 = new ParamStore(schema, 'eng');
  s2.set('temp', 50);
  s2.set('heater', true);
  // raising temp above 80 while heater on also violates the interlock
  assert.throws(() => s2.set('temp', 95), ValidationError);
});

test('unknown key and bad expressions are VALIDATION errors', () => {
  const s = new ParamStore(schema, 'eng');
  assert.throws(() => s.set('nope', 1), ValidationError);
  assert.throws(() => compileSchema([{ key: 'x', type: 'number', interlock: 'y > 1' }]), ValidationError);
  assert.throws(() => compileSchema([{ key: 'x', type: 'number', interlock: '1 +' }]), ValidationError);
});

test('lock/unlock are captured; set on locked param fails', () => {
  const s = new ParamStore(schema, 'eng');
  s.set('temp', 10);
  s.lock('temp');
  assert.throws(() => s.set('temp', 20), (e) => e.code === 'VALIDATION' && /locked/.test(e.message));
  assert.throws(() => s.lock('temp'), ValidationError);
  s.unlock('temp');
  s.set('temp', 20);
  assert.equal(s.get('temp'), 20);
  assert.deepEqual(s.deltas.map((d) => d.op), ['set', 'lock', 'unlock', 'set']);
});
