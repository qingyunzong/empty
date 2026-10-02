import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDatasets, mergeField, canonicalJson, ABSENT } from '../src/merge.js';
import { buildCertificate, sha256Hex } from '../src/certificate.js';

test('independent modifications on different fields auto-merge', () => {
  const base = {
    obs1: { value: 10, unit: 'm', tags: ['a'], annotations: { note: 'x' } },
  };
  const left = {
    obs1: { value: 42, unit: 'm', tags: ['a'], annotations: { note: 'x' } },
  };
  const right = {
    obs1: { value: 10, unit: 'cm', tags: ['a', 'b'], annotations: { note: 'x' } },
  };
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.obs1, {
    value: 42,
    unit: 'cm',
    tags: ['a', 'b'],
    annotations: { note: 'x' },
  });
});

test('same field changed to different values on both sides conflicts', () => {
  const base = { obs1: { value: 1, unit: 'm' } };
  const left = { obs1: { value: 2, unit: 'm' } };
  const right = { obs1: { value: 3, unit: 'm' } };
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'both-modified');
  assert.equal(conflicts[0].id, 'obs1');
  assert.equal(conflicts[0].field, 'value');
  assert.equal(conflicts[0].left, 2);
  assert.equal(conflicts[0].right, 3);
  assert.deepEqual(merged, { obs1: { unit: 'm' } });
});

test('empty datasets merge to empty result', () => {
  const { merged, conflicts } = mergeDatasets({}, {}, {});
  assert.deepEqual(merged, {});
  assert.deepEqual(conflicts, []);
});

test('identical modifications on both sides auto-merge', () => {
  const base = { obs1: { value: 1, unit: 'm' } };
  const left = { obs1: { value: 9, unit: 's' } };
  const right = { obs1: { value: 9, unit: 's' } };
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged, { obs1: { value: 9, unit: 's' } });
});

test('both sides deleting the same record is clean', () => {
  const base = { obs1: { value: 1 } };
  const { merged, conflicts } = mergeDatasets(base, {}, {});
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged, {});
});

test('modify vs delete is classified as modify-delete', () => {
  const base = { obs1: { value: 1 } };
  const left = { obs1: { value: 2 } };
  const right = {};
  const { conflicts } = mergeDatasets(base, left, right);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'modify-delete');
  assert.equal(conflicts[0].left.value, 2);
  assert.equal(conflicts[0].right, null);

  const mirror = mergeDatasets(base, {}, { obs1: { value: 7 } });
  assert.equal(mirror.conflicts.length, 1);
  assert.equal(mirror.conflicts[0].type, 'modify-delete');
  assert.equal(mirror.conflicts[0].left, null);
});

test('delete vs unmodified is a clean delete', () => {
  const base = { obs1: { value: 1 }, obs2: { value: 2 } };
  const left = { obs2: { value: 2 } };
  const right = { obs1: { value: 1 }, obs2: { value: 2 } };
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged, { obs2: { value: 2 } });
});

test('record missing from baseline but added on one side is taken', () => {
  const base = {};
  const left = { obs9: { value: 5, unit: 'kg' } };
  const right = {};
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged, { obs9: { value: 5, unit: 'kg' } });
});

test('record added identically on both sides merges; differently conflicts as both-added', () => {
  const same = mergeDatasets({}, { a: { value: 1 } }, { a: { value: 1 } });
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.merged, { a: { value: 1 } });

  const diff = mergeDatasets({}, { a: { value: 1 } }, { a: { value: 2 } });
  assert.equal(diff.conflicts.length, 1);
  assert.equal(diff.conflicts[0].type, 'both-added');
  assert.deepEqual(diff.merged, {});
});

test('field-level eight-state enumeration (base/left/right presence)', () => {
  const B = 100;
  const L = 200;
  const R = 300;
  const rec = (has, v) => (has ? { value: v } : {});

  const cases = [
    { name: '000 absent everywhere', base: rec(false), left: rec(false), right: rec(false), expect: { kind: 'absent' } },
    { name: '001 only right has it (added by right)', base: rec(false), left: rec(false), right: rec(true, R), expect: { kind: 'value', value: R } },
    { name: '010 only left has it (added by left)', base: rec(false), left: rec(true, L), right: rec(false), expect: { kind: 'value', value: L } },
    { name: '011 added on both, identical', base: rec(false), left: rec(true, L), right: rec(true, L), expect: { kind: 'value', value: L } },
    { name: '011 added on both, different', base: rec(false), left: rec(true, L), right: rec(true, R), expect: { kind: 'conflict', type: 'both-added' } },
    { name: '100 only in base (deleted by both)', base: rec(true, B), left: rec(false), right: rec(false), expect: { kind: 'absent' } },
    { name: '101 left deleted, right unchanged', base: rec(true, B), left: rec(false), right: rec(true, B), expect: { kind: 'absent' } },
    { name: '101 left deleted, right modified', base: rec(true, B), left: rec(false), right: rec(true, R), expect: { kind: 'conflict', type: 'modify-delete' } },
    { name: '110 right deleted, left unchanged', base: rec(true, B), left: rec(true, B), right: rec(false), expect: { kind: 'absent' } },
    { name: '110 right deleted, left modified', base: rec(true, B), left: rec(true, L), right: rec(false), expect: { kind: 'conflict', type: 'modify-delete' } },
    { name: '111 all present, none changed', base: rec(true, B), left: rec(true, B), right: rec(true, B), expect: { kind: 'value', value: B } },
    { name: '111 all present, only left changed', base: rec(true, B), left: rec(true, L), right: rec(true, B), expect: { kind: 'value', value: L } },
    { name: '111 all present, only right changed', base: rec(true, B), left: rec(true, B), right: rec(true, R), expect: { kind: 'value', value: R } },
    { name: '111 all present, both changed identically', base: rec(true, B), left: rec(true, L), right: rec(true, L), expect: { kind: 'value', value: L } },
    { name: '111 all present, both changed differently', base: rec(true, B), left: rec(true, L), right: rec(true, R), expect: { kind: 'conflict', type: 'both-modified' } },
  ];

  for (const c of cases) {
    const { merged, conflicts } = mergeDatasets({ r1: c.base }, { r1: c.left }, { r1: c.right });
    if (c.expect.kind === 'absent') {
      assert.deepEqual(conflicts, [], c.name);
      assert.ok(!('value' in (merged.r1 ?? {})), c.name);
    } else if (c.expect.kind === 'value') {
      assert.deepEqual(conflicts, [], c.name);
      assert.equal(merged.r1.value, c.expect.value, c.name);
    } else {
      assert.equal(conflicts.length, 1, c.name);
      assert.equal(conflicts[0].type, c.expect.type, c.name);
      assert.equal(conflicts[0].field, 'value', c.name);
    }
  }
});

test('mergeField treats nested structures by deep equality', () => {
  const b = { tags: ['a'], annotations: { q: 1 } };
  const l = { tags: ['a', 'b'], annotations: { q: 1 } };
  const r = { tags: ['a'], annotations: { q: 2 } };
  const { merged, conflicts } = mergeDatasets({ x: b }, { x: l }, { x: r });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged.x, { tags: ['a', 'b'], annotations: { q: 2 } });
});

test('mergeField direct: untouched field returns base', () => {
  const res = mergeField(1, 1, 1);
  assert.equal(res.status, 'clean');
  assert.equal(res.value, 1);
  const absent = mergeField(ABSENT, ABSENT, ABSENT);
  assert.equal(absent.status, 'clean');
  assert.equal(absent.value, ABSENT);
});

test('certificate digest is deterministic and matches canonical merged json', () => {
  const merged = { b: { value: 1 }, a: { tags: ['x'] } };
  const cert1 = buildCertificate({ merged, inputs: { base: '{}', left: '{}', right: '{}' } });
  const cert2 = buildCertificate({ merged, inputs: { base: '{}', left: '{}', right: '{}' } });
  assert.equal(cert1.algorithm, 'sha256');
  assert.equal(cert1.recordCount, 2);
  assert.equal(cert1.mergedDigest, cert2.mergedDigest);
  assert.equal(cert1.mergedDigest, sha256Hex(canonicalJson(merged)));
  assert.match(cert1.mergedDigest, /^[0-9a-f]{64}$/);
  assert.match(cert1.inputs.base, /^[0-9a-f]{64}$/);
});
