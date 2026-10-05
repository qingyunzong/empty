import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicySnapshot, DEFAULT_MASK_REPLACEMENT } from '../src/policy.js';
import { createTable } from '../src/table.js';
import { runQuery } from '../src/engine.js';

test('snapshot is deeply frozen', () => {
  const snap = createPolicySnapshot({
    rowFilter: { op: 'eq', field: 'dept', value: 'eng' },
    masks: [{ field: 'ssn', when: { op: 'lit', value: true } }],
  });
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.rowFilter));
  assert.ok(Object.isFrozen(snap.masks));
  assert.ok(Object.isFrozen(snap.masks[0]));
  assert.ok(Object.isFrozen(snap.masks[0]!.when));
  assert.throws(() => {
    (snap as { rowFilter: unknown }).rowFilter = { op: 'lit', value: true };
  }, TypeError);
});

test('mutating the original policy after snapshotting has no effect', () => {
  const policy = {
    rowFilter: { op: 'eq', field: 'dept', value: 'eng' } as const,
    masks: [{ field: 'ssn', when: { op: 'lit', value: true } as const }],
  };
  const snap = createPolicySnapshot(policy);
  (policy.rowFilter as { value: string }).value = 'sales';
  (policy.masks[0]!.when as { value: boolean }).value = false;

  const table = createTable('t', [
    { id: 'a', dept: 'eng', ssn: '111' },
    { id: 'b', dept: 'sales', ssn: '222' },
  ]);
  const out = runQuery(table, snap, {});
  assert.deepEqual(out, [{ id: 'a', dept: 'eng', ssn: DEFAULT_MASK_REPLACEMENT, sourceRowIds: ['a'] }]);
});

test('default mask replacement is applied and custom replacement is honored', () => {
  const snapDefault = createPolicySnapshot({
    rowFilter: { op: 'lit', value: true },
    masks: [{ field: 'ssn', when: { op: 'lit', value: true } }],
  });
  const snapCustom = createPolicySnapshot({
    rowFilter: { op: 'lit', value: true },
    masks: [{ field: 'ssn', when: { op: 'lit', value: true }, replacement: '<hidden>' }],
  });
  const table = createTable('t', [{ id: 'a', ssn: '111' }]);
  assert.equal(runQuery(table, snapDefault, {})[0]!.ssn, '***');
  assert.equal(runQuery(table, snapCustom, {})[0]!.ssn, '<hidden>');
});

test('each snapshot gets a unique id', () => {
  const a = createPolicySnapshot({ rowFilter: { op: 'lit', value: true } });
  const b = createPolicySnapshot({ rowFilter: { op: 'lit', value: true } });
  assert.notEqual(a.id, b.id);
});

test('snapshot requires a rowFilter', () => {
  assert.throws(() => createPolicySnapshot({} as never), /rowFilter/);
});
