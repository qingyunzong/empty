import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../src/store.js';
import { PlannerError, E_STATE, E_LIMIT } from '../src/errors.js';

function storeWithJob() {
  const s = new JobStore();
  s.add({ id: 'J1', description: '低温 固化 M E', material: 'M', equipment: 'E', cost: 5, overdue: 1 });
  return s;
}

test('E_STATE: duplicate add, void missing, double void, restore active', () => {
  const s = storeWithJob();
  assert.throws(() => s.add({ id: 'J1', description: 'x', material: 'M', equipment: 'E', cost: 1, overdue: 0 }),
    (e) => e instanceof PlannerError && e.code === E_STATE);
  assert.throws(() => s.void('NOPE'), (e) => e.code === E_STATE);
  s.void('J1');
  assert.throws(() => s.void('J1'), (e) => e.code === E_STATE);
  assert.throws(() => s.restore('J2'), (e) => e.code === E_STATE);
  const s2 = storeWithJob();
  assert.throws(() => s2.restore('J1'), (e) => e.code === E_STATE);
});

test('E_LIMIT: invalid fields on add', () => {
  const s = new JobStore();
  assert.throws(() => s.add({ id: '', description: 'x', material: 'M', equipment: 'E', cost: 1, overdue: 0 }), (e) => e.code === E_LIMIT);
  assert.throws(() => s.add({ id: 'A', description: 'x', material: 'M', equipment: 'E', cost: -1, overdue: 0 }), (e) => e.code === E_LIMIT);
  assert.throws(() => s.add({ id: 'A', description: 'x', material: 'M', equipment: 'E', cost: 1.5, overdue: 0 }), (e) => e.code === E_LIMIT);
});

test('void/restore lifecycle keeps audit and round-trips via JSON', () => {
  const s = storeWithJob();
  s.void('J1');
  s.restore('J1');
  s.void('J1');
  assert.deepEqual(s.audit.map((a) => a.op), ['add', 'void', 'restore', 'void']);
  const revived = JobStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  assert.equal(revived.jobs.get('J1').voided, true);
  assert.equal(revived.audit.length, 4);
});
