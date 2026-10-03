import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AlertStore } from '../src/store.js';
import { tmpdir, cleanup } from './helpers.js';

// Tiny ring: one record per segment, at most two live segments.
const RING = { chunkSize: 64, segmentChunks: 1, maxSegments: 2 };
const rec = (seq) => ({ device: 'd1', seq, severity: 'info', message: `m${seq}` });

test('crash before manifest rename keeps old segments and the cursor certificate', async () => {
  const dir = await tmpdir();
  try {
    // Fill the ring and obtain a cursor certificate for the acknowledged prefix.
    let store = await AlertStore.open(dir, RING);
    await store.append(rec(1));
    await store.append(rec(2));
    const certified = await store.replay({});
    assert.deepEqual(certified.cursor, { d1: 2 });
    await store.close();

    // Overwrite attempt: new segment is written, then we "crash" right before
    // the manifest rename.
    store = await AlertStore.open(dir, {
      ...RING,
      hooks: {
        beforeManifestRename() {
          throw new Error('simulated crash');
        },
      },
    });
    await assert.rejects(store.append(rec(3)), /simulated crash/);

    // After restart the old manifest is authoritative: the acknowledged prefix
    // pointed to by the cursor certificate is unchanged and fully readable.
    store = await AlertStore.open(dir, RING);
    const after = await store.replay({});
    assert.equal(after.error, undefined);
    assert.deepEqual(after.cursor, certified.cursor);
    assert.deepEqual(after.alerts.map((a) => a.seq), [1, 2]);
    // The orphaned new segment was cleaned up on open.
    assert.deepEqual((await fs.readdir(path.join(dir, 'segments'))).sort(), [
      'seg-000001.dat',
      'seg-000002.dat',
    ]);
    await store.close();

    // A completed overwrite publishes the new segment and evicts the oldest.
    store = await AlertStore.open(dir, RING);
    await store.append(rec(3));
    await store.append(rec(4));
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.segments.map((s) => s.id), [3, 4]);
    await assert.rejects(fs.stat(path.join(dir, 'segments', 'seg-000001.dat')), { code: 'ENOENT' });

    // Replay from the old cursor certificate continues seamlessly at seq 3.
    const cont = await store.replay(certified.cursor);
    assert.equal(cont.error, undefined);
    assert.deepEqual(cont.alerts.map((a) => a.seq), [3, 4]);
    assert.deepEqual(cont.cursor, { d1: 4 });
    await store.close();
  } finally {
    await cleanup(dir);
  }
});
