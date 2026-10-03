import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { syncStores } from '../src/sync.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lg-sync-'));
}

test('bidirectional sync converges version vectors and is idempotent', () => {
  const da = path.join(tmpdir(), 'a');
  const db = path.join(tmpdir(), 'b');
  const a = Store.init(da, { site: 'A' });
  const b = Store.init(db, { site: 'B' });
  a.add({ op: 'register', out: [{ lot: 'M', mass: 100 }], site: 'A' });
  a.add({ op: 'split', in: [{ lot: 'M', mass: 100 }], out: [{ lot: 'S1', mass: 60 }, { lot: 'S2', mass: 40 }], site: 'A' });
  b.add({ op: 'register', out: [{ lot: 'X', mass: 10 }], site: 'B' });

  const r1 = syncStores(a, b);
  assert.equal(r1.sentToPeer, 2);
  assert.equal(r1.receivedFromPeer, 1);
  assert.deepEqual(a.graph.vv, b.graph.vv);

  const r2 = syncStores(a, b); // repeat: nothing to exchange
  assert.equal(r2.sentToPeer, 0);
  assert.equal(r2.receivedFromPeer, 0);
  assert.equal(a.entries.length, 3);
  assert.equal(b.entries.length, 3);

  // both sides see identical edge sets (duplicate edges idempotent)
  const idsA = a.entries.map((e) => e.id).sort();
  const idsB = b.entries.map((e) => e.id).sort();
  assert.deepEqual(idsA, idsB);
  assert.equal(new Set(idsA).size, 3);
});

test('unknown parent via sync stays pending, later sync converges it', () => {
  const da = path.join(tmpdir(), 'a');
  const db = path.join(tmpdir(), 'b');
  const a = Store.init(da, { site: 'A' });
  const b = Store.init(db, { site: 'B' });
  // B records a merge consuming lots it has never seen: pending, not failure.
  b.add({ op: 'merge', in: [{ lot: 'P', mass: 10 }, { lot: 'Q', mass: 10 }], out: [{ lot: 'R', mass: 20 }], site: 'B', ts: 10 });
  assert.equal(b.graph.pending.length, 1);
  syncStores(a, b); // A learns of the pending op too
  assert.equal(a.graph.pending.length, 1);
  // A later produces the missing parents with earlier timestamps.
  a.add({ op: 'register', out: [{ lot: 'P', mass: 10 }], site: 'A', ts: 1 });
  a.add({ op: 'register', out: [{ lot: 'Q', mass: 10 }], site: 'A', ts: 1 });
  syncStores(a, b);
  assert.equal(b.graph.pending.length, 0);
  assert.ok(b.graph.lots.has('R'));
  assert.equal(b.graph.lots.get('R').mass, 20);
});
