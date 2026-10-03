import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDatasets, mergeField, ABSENT } from '../src/merge.js';
import { buildCertificate } from '../src/certificate.js';
import { hashValue } from '../src/canonical.js';

test('independent modifications on different fields auto-merge', () => {
  const base = {
    obs1: { value: 10, unit: 'm', tags: ['a'], annotations: { note: 'x' } },
    obs2: { value: 20, unit: 's' },
  };
  const left = {
    obs1: { value: 11, unit: 'm', tags: ['a'], annotations: { note: 'x' } },
    obs2: { value: 20, unit: 's' },
  };
  const right = {
    obs1: { value: 10, unit: 'cm', tags: ['a', 'b'], annotations: { note: 'x' } },
    obs2: { value: 21, unit: 's' },
  };
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.obs1.value, 11); // from left
  assert.equal(merged.obs1.unit, 'cm'); // from right
  assert.deepEqual(merged.obs1.tags, ['a', 'b']); // from right
  assert.equal(merged.obs2.value, 21); // from right
});

test('same field changed to different values conflicts', () => {
  const base = { obs1: { value: 1, unit: 'm' } };
  const left = { obs1: { value: 2, unit: 'm' } };
  const right = { obs1: { value: 3, unit: 'm' } };
  const { merged, conflicts } = mergeDatasets(base, left, right);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].type, 'both-modified');
  assert.equal(conflicts[0].id, 'obs1');
  assert.equal(conflicts[0].field, 'value');
  assert.deepEqual(merged, {}); // no partial record emitted
});

test('edge cases: empty datasets and identical modifications', () => {
  // All three empty.
  const empty = mergeDatasets({}, {}, {});
  assert.deepEqual(empty.merged, {});
  assert.deepEqual(empty.conflicts, []);

  // Both sides apply the identical change -> clean merge.
  const base = { obs1: { value: 1, unit: 'm' } };
  const changed = { obs1: { value: 9, unit: 'm' } };
  const same = mergeDatasets(base, changed, changed);
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.merged, changed);

  // All three identical -> unchanged.
  const identical = mergeDatasets(base, base, base);
  assert.deepEqual(identical.merged, base);
  assert.deepEqual(identical.conflicts, []);
});

test('record-level classification: both-deleted, modify-vs-delete, both-added', () => {
  // Deleted on both sides -> silently gone.
  const bothDeleted = mergeDatasets({ a: { value: 1 } }, {}, {});
  assert.deepEqual(bothDeleted.merged, {});
  assert.deepEqual(bothDeleted.conflicts, []);

  // Deleted on one side, untouched on the other -> deleted.
  const oneDeleted = mergeDatasets({ a: { value: 1 } }, {}, { a: { value: 1 } });
  assert.deepEqual(oneDeleted.merged, {});
  assert.deepEqual(oneDeleted.conflicts, []);

  // Deleted on one side, modified on the other -> conflict.
  const modVsDel = mergeDatasets({ a: { value: 1 } }, {}, { a: { value: 2 } });
  assert.equal(modVsDel.conflicts.length, 1);
  assert.equal(modVsDel.conflicts[0].type, 'modified-vs-deleted');
  assert.equal(modVsDel.conflicts[0].left, null);

  // Added identically on both sides -> clean.
  const addSame = mergeDatasets({}, { a: { value: 5 } }, { a: { value: 5 } });
  assert.deepEqual(addSame.merged, { a: { value: 5 } });
  assert.deepEqual(addSame.conflicts, []);

  // Added differently on both sides -> conflict.
  const addDiff = mergeDatasets({}, { a: { value: 5 } }, { a: { value: 6 } });
  assert.equal(addDiff.conflicts.length, 1);
  assert.equal(addDiff.conflicts[0].type, 'both-added');
});

test('field-level enumeration: all 8 base/left/right presence states', () => {
  // For each of the 2^3 presence combinations of (base, left, right),
  // run an independent merge of a single field and check the outcome.
  // Present-with-value uses distinct markers so the source of every
  // merged value is unambiguous.
  const B = { v: 'base' };
  const L = { v: 'left' };
  const R = { v: 'right' };

  const cases = [
    // name, base, left, right, expected value (ABSENT = field dropped) or conflict type
    ['000 absent/absent/absent', ABSENT, ABSENT, ABSENT, { value: ABSENT }],
    ['001 right only (added by right)', ABSENT, ABSENT, R, { value: R }],
    ['010 left only (added by left)', ABSENT, L, ABSENT, { value: L }],
    ['011 added both, different -> conflict', ABSENT, L, R, { conflict: 'both-added' }],
    ['100 base only (deleted both)', B, ABSENT, ABSENT, { value: ABSENT }],
    ['101 left deleted, right untouched', B, ABSENT, B, { value: ABSENT }],
    ['110 right deleted, left untouched', B, B, ABSENT, { value: ABSENT }],
    ['111 untouched everywhere', B, B, B, { value: B }],
  ];

  for (const [name, b, l, r, expected] of cases) {
    const res = mergeField(b, l, r);
    if (expected.conflict) {
      assert.ok(res.conflict, `${name}: expected conflict`);
      assert.equal(res.conflict.type, expected.conflict, name);
    } else {
      assert.ok(!res.conflict, `${name}: unexpected conflict ${JSON.stringify(res.conflict)}`);
      assert.equal(res.value, expected.value, name);
    }
  }

  // Sub-states of 111 where sides actually change values.
  assert.deepEqual(mergeField(B, L, B), { value: L }); // left changed only
  assert.deepEqual(mergeField(B, B, R), { value: R }); // right changed only
  assert.deepEqual(mergeField(B, L, L), { value: L }); // identical change both sides
  assert.equal(mergeField(B, L, R).conflict.type, 'both-modified'); // divergent change

  // Delete-vs-modify at field level (presence states 101/110 with a changed survivor).
  assert.equal(mergeField(B, ABSENT, R).conflict.type, 'modified-vs-deleted');
  assert.equal(mergeField(B, L, ABSENT).conflict.type, 'modified-vs-deleted');
});

test('certificate is deterministic SHA-256 of canonical state', () => {
  const base = { obs1: { value: 1 } };
  const left = { obs1: { value: 2 } };
  const right = { obs1: { value: 1 } };
  const { merged, stats } = mergeDatasets(base, left, right);
  const cert = buildCertificate({ base, left, right, merged, stats });
  assert.equal(cert.algorithm, 'sha256');
  assert.match(cert.merged.sha256, /^[0-9a-f]{64}$/);
  assert.equal(cert.merged.sha256, hashValue(merged));
  assert.equal(cert.inputs.base, hashValue(base));
  // Key order in inputs must not affect hashes.
  const leftReordered = { obs1: { value: 2 } };
  assert.equal(cert.inputs.left, hashValue(leftReordered));
});
