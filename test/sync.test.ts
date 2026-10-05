import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPlan,
  merge,
  ResolutionStore,
  verifyMerge,
  type DocFile,
  type Snapshot,
} from '../src/index.js';

function file(id: string, path: string, fields: DocFile['fields'] = {}): DocFile {
  return { id, path, fields };
}

function snap(...files: DocFile[]): Snapshot {
  const filesById: Snapshot['files'] = {};
  for (const f of files) filesById[f.id] = f;
  return { files: filesById };
}

function mergeAndVerify(base: Snapshot, local: Snapshot, remote: Snapshot, store: ResolutionStore) {
  const result = merge(base, local, remote, store);
  const violations = verifyMerge(base, local, remote, result);
  assert.deepEqual(violations, [], `verification violations:\n${violations.join('\n')}`);
  return result;
}

describe('three-way merge by stable file id', () => {
  it('passes through one-sided creates, modifies and deletes', () => {
    const base = snap(
      file('a', '/docs/a.md', { title: 'A' }),
      file('b', '/docs/b.md', { title: 'B' }),
    );
    const local = snap(
      file('a', '/docs/a.md', { title: 'A', draft: true }),
      file('c', '/docs/c.md', { title: 'C' }),
    );
    const remote = snap(
      file('a', '/docs/a.md', { title: 'A' }),
      file('b', '/docs/b.md', { title: 'B' }),
    );
    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.merged.files['a'], file('a', '/docs/a.md', { title: 'A', draft: true }));
    assert.equal(result.merged.files['b'], undefined, 'deleted on local stays deleted');
    assert.deepEqual(result.merged.files['c'], file('c', '/docs/c.md', { title: 'C' }));
    assert.ok(result.plan);
    assert.equal(result.plan.atomic, true);
  });

  it('merges different fields changed on each side', () => {
    const base = snap(file('f1', '/f1.md', { title: 'old', body: 'x', tags: 'a' }));
    const local = snap(file('f1', '/f1.md', { title: 'new-local', body: 'x', tags: 'a' }));
    const remote = snap(file('f1', '/f1.md', { title: 'old', body: 'y', tags: 'a' }));
    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.merged.files['f1'], file('f1', '/f1.md', {
      title: 'new-local',
      body: 'y',
      tags: 'a',
    }));
  });

  it('accepts identical changes on both sides without conflict', () => {
    const base = snap(file('f1', '/f1.md', { title: 'old' }));
    const local = snap(file('f1', '/renamed.md', { title: 'same' }));
    const remote = snap(file('f1', '/renamed.md', { title: 'same' }));
    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.merged.files['f1'], file('f1', '/renamed.md', { title: 'same' }));
  });

  it('tracks files by id across renames, not by path', () => {
    const base = snap(file('f1', '/old.md', { title: 't' }));
    const local = snap(file('f1', '/new.md', { title: 't' }));
    const remote = snap(file('f1', '/old.md', { title: 't', body: 'added' }));
    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.merged.files['f1'], file('f1', '/new.md', { title: 't', body: 'added' }));
  });
});

describe('conflicts and resolutions', () => {
  it('reports a field conflict and resolves it per side', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base' }));
    const local = snap(file('f1', '/f1.md', { title: 'local' }));
    const remote = snap(file('f1', '/f1.md', { title: 'remote' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    assert.equal(first.plan, null, 'no plan while conflicts are open');
    assert.equal(first.conflicts.length, 1);
    assert.equal(first.conflicts[0]!.key, 'f1:field:title');
    assert.equal(first.conflicts[0]!.kind, 'field');
    assert.equal(first.merged.files['f1'], undefined, 'conflicted file is omitted');

    store.resolve(first.conflicts[0]!, 'remote');
    const second = mergeAndVerify(base, local, remote, store);
    assert.deepEqual(second.conflicts, []);
    assert.equal(second.merged.files['f1']!.fields['title'], 'remote');
    assert.deepEqual(second.revoked, []);
  });

  it('reports delete-vs-modify and resolves both ways', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base' }));
    const local = snap();
    const remote = snap(file('f1', '/f1.md', { title: 'edited' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    assert.equal(first.conflicts.length, 1);
    assert.equal(first.conflicts[0]!.kind, 'delete-vs-modify');
    assert.equal(first.plan, null);

    store.resolve(first.conflicts[0]!, 'local');
    const keepDelete = mergeAndVerify(base, local, remote, store);
    assert.equal(keepDelete.merged.files['f1'], undefined, 'local choice keeps the deletion');

    const store2 = new ResolutionStore();
    const again = mergeAndVerify(base, local, remote, store2);
    store2.resolve(again.conflicts[0]!, 'remote');
    const keepModify = mergeAndVerify(base, local, remote, store2);
    assert.deepEqual(keepModify.merged.files['f1'], file('f1', '/f1.md', { title: 'edited' }));
  });

  it('reports a path conflict when both sides rename differently', () => {
    const base = snap(file('f1', '/base.md', { title: 't' }));
    const local = snap(file('f1', '/local.md', { title: 't' }));
    const remote = snap(file('f1', '/remote.md', { title: 't' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    assert.equal(first.conflicts.length, 1);
    assert.equal(first.conflicts[0]!.kind, 'path');

    store.resolve(first.conflicts[0]!, 'local');
    const second = mergeAndVerify(base, local, remote, store);
    assert.equal(second.merged.files['f1']!.path, '/local.md');
  });

  it('reports same-target-path occupancy and resolves it', () => {
    const base = snap(file('a', '/a.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
    const local = snap(file('a', '/shared.md', { title: 'A' }), file('b', '/b.md', { title: 'B' }));
    const remote = snap(file('a', '/a.md', { title: 'A' }), file('b', '/shared.md', { title: 'B' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    assert.equal(first.conflicts.length, 1);
    assert.equal(first.conflicts[0]!.kind, 'path-occupancy');
    assert.equal(first.conflicts[0]!.key, 'occupancy:/shared.md');
    assert.deepEqual(first.conflicts[0]!.fileIds, ['a', 'b']);
    assert.equal(first.plan, null);

    store.resolve(first.conflicts[0]!, 'local');
    const second = mergeAndVerify(base, local, remote, store);
    assert.deepEqual(second.conflicts, []);
    assert.equal(second.merged.files['a']!.path, '/shared.md');
    assert.equal(second.merged.files['b']!.path, '/b.md');

    const store2 = new ResolutionStore();
    const again = mergeAndVerify(base, local, remote, store2);
    store2.resolve(again.conflicts[0]!, 'remote');
    const third = mergeAndVerify(base, local, remote, store2);
    assert.equal(third.merged.files['a']!.path, '/a.md');
    assert.equal(third.merged.files['b']!.path, '/shared.md');
  });

  it('rejects snapshots that already occupy one path twice', () => {
    const base = snap(file('a', '/x.md'));
    const local = snap(file('a', '/x.md'), file('b', '/x.md'));
    const remote = snap(file('a', '/x.md'));
    assert.throws(() => merge(base, local, remote, new ResolutionStore()), /occupied/);
  });
});

describe('stale resolution revocation', () => {
  it('revokes a resolution when the source versions change', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base' }));
    const local = snap(file('f1', '/f1.md', { title: 'local' }));
    const remote = snap(file('f1', '/f1.md', { title: 'remote' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    store.resolve(first.conflicts[0]!, 'local');

    const applied = mergeAndVerify(base, local, remote, store);
    assert.deepEqual(applied.conflicts, []);
    assert.equal(applied.resolved.length, 1);
    assert.equal(store.size, 1);

    // Remote edits the same field again: the recorded choice is now stale.
    const remoteV2 = snap(file('f1', '/f1.md', { title: 'remote-v2' }));
    const stale = mergeAndVerify(base, local, remoteV2, store);
    assert.equal(stale.conflicts.length, 1, 'conflict resurfaces');
    assert.equal(stale.revoked.length, 1, 'stale resolution is revoked');
    assert.equal(stale.revoked[0]!.key, 'f1:field:title');
    assert.equal(store.size, 0, 'revoked resolution leaves the store');
    assert.equal(stale.plan, null);
  });

  it('keeps a field resolution when an unrelated field changes', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base', body: 'x' }));
    const local = snap(file('f1', '/f1.md', { title: 'local', body: 'x' }));
    const remote = snap(file('f1', '/f1.md', { title: 'remote', body: 'x' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    store.resolve(first.conflicts[0]!, 'local');
    mergeAndVerify(base, local, remote, store);

    const remoteV2 = snap(file('f1', '/f1.md', { title: 'remote', body: 'y' }));
    const result = mergeAndVerify(base, local, remoteV2, store);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.revoked, []);
    assert.equal(result.merged.files['f1']!.fields['title'], 'local');
    assert.equal(result.merged.files['f1']!.fields['body'], 'y');
  });

  it('revokes resolutions whose conflict disappeared entirely', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base' }));
    const local = snap(file('f1', '/f1.md', { title: 'local' }));
    const remote = snap(file('f1', '/f1.md', { title: 'remote' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    store.resolve(first.conflicts[0]!, 'local');

    // Remote converges to the local value: no conflict remains.
    const converged = snap(file('f1', '/f1.md', { title: 'local' }));
    const result = mergeAndVerify(base, local, converged, store);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.revoked.length, 1);
    assert.equal(store.size, 0);
  });
});

describe('atomic change plan', () => {
  it('transforms local into merged exactly', () => {
    const base = snap(
      file('keep', '/keep.md', { title: 'k' }),
      file('gone', '/gone.md', { title: 'g' }),
      file('moved', '/old.md', { title: 'm', body: 'b' }),
    );
    const local = snap(
      file('keep', '/keep.md', { title: 'k' }),
      file('moved', '/new.md', { title: 'm', body: 'b' }),
    );
    const remote = snap(
      file('keep', '/keep.md', { title: 'k', tags: 't' }),
      file('gone', '/gone.md', { title: 'g' }),
      file('moved', '/old.md', { title: 'm2', body: 'b', extra: 1 }),
      file('born', '/born.md', { title: 'new' }),
    );

    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    assert.ok(result.plan);
    const applied = applyPlan(local, result.plan);
    assert.deepEqual(applied, result.merged);

    const kinds = result.plan.ops.map((op) => op.op).sort();
    assert.deepEqual(kinds, ['create', 'update', 'update']);
  });

  it('is empty when local already equals merged', () => {
    const base = snap(file('a', '/a.md', { title: 't' }));
    const local = snap(file('a', '/a.md', { title: 't' }));
    const remote = snap(file('a', '/a.md', { title: 't' }));
    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    assert.ok(result.plan);
    assert.deepEqual(result.plan.ops, []);
  });

  it('enforces preconditions when applying a plan', () => {
    const local = snap(file('a', '/a.md', { title: 't' }));
    assert.throws(
      () =>
        applyPlan(local, {
          atomic: true,
          ops: [{ op: 'move', id: 'a', from: '/wrong.md', to: '/b.md' }],
        }),
      /precondition/,
    );
    assert.throws(
      () => applyPlan(local, { atomic: true, ops: [{ op: 'delete', id: 'missing' }] }),
      /precondition/,
    );
  });
});

describe('per-file three-way verification', () => {
  it('detects tampering with the merged output', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base', body: 'x' }));
    const local = snap(file('f1', '/f1.md', { title: 'local', body: 'x' }));
    const remote = snap(file('f1', '/f1.md', { title: 'base', body: 'y' }));

    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    const tampered = {
      ...result,
      merged: snap(file('f1', '/f1.md', { title: 'hacked', body: 'y' })),
    };
    const violations = verifyMerge(base, local, remote, tampered);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.includes('title')));
  });

  it('detects a plan that does not reproduce the merged state', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base' }));
    const local = snap(file('f1', '/f1.md', { title: 'base' }));
    const remote = snap(file('f1', '/f1.md', { title: 'remote' }));

    const result = mergeAndVerify(base, local, remote, new ResolutionStore());
    const broken = { ...result, plan: { atomic: true as const, ops: [] } };
    const violations = verifyMerge(base, local, remote, broken);
    assert.ok(violations.some((v) => v.includes('does not reproduce')));
  });
});

describe('resolution store persistence', () => {
  it('round-trips through JSON', () => {
    const base = snap(file('f1', '/f1.md', { title: 'base' }));
    const local = snap(file('f1', '/f1.md', { title: 'local' }));
    const remote = snap(file('f1', '/f1.md', { title: 'remote' }));

    const store = new ResolutionStore();
    const first = mergeAndVerify(base, local, remote, store);
    store.resolve(first.conflicts[0]!, 'remote');

    const restored = ResolutionStore.fromJSON(store.toJSON());
    const result = mergeAndVerify(base, local, remote, restored);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.merged.files['f1']!.fields['title'], 'remote');
  });
});
