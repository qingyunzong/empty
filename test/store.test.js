'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BiobankStore, StoreError } = require('../src/store');
const {
  tmpdir, prng, TYPES, randomDate, randomSample,
  bruteFind, bruteScanType, bruteScanDate,
} = require('./helpers');

function verifyAgainstRef(store, ref, liveIds, rand, label) {
  for (const id of liveIds) {
    assert.deepEqual(store.find(id), bruteFind(ref, id), `${label}: find ${id}`);
  }
  for (const type of TYPES) {
    assert.deepEqual(store.scanByType(type), bruteScanType(ref, type), `${label}: scan type ${type}`);
  }
  const ranges = [
    ['0000-00-00', '9999-99-99'],
    ['2020-01-01', '2021-12-31'],
    ['2022-06-15', '2023-06-14'],
    ['2024-01-01', '2024-01-31'],
    ['2026-01-01', '2026-12-31'],
    ['2025-06-01', '2025-05-01'], // empty: from > to
  ];
  for (let i = 0; i < 10; i++) {
    const a = randomDate(rand);
    const b = randomDate(rand);
    ranges.push(a <= b ? [a, b] : [b, a]);
  }
  for (const [from, to] of ranges) {
    assert.deepEqual(
      store.scanByDateRange(from, to),
      bruteScanDate(ref, from, to),
      `${label}: scan date ${from}..${to}`,
    );
  }
}

// Runs 5000 mixed add/update/remove ops against the store, mirroring into ref.
async function runMixedWorkload(store, ref, liveIds, rand, total, startSeq) {
  let seq = startSeq;
  for (let i = 0; i < total; i++) {
    const roll = rand();
    if (roll < 0.5 || liveIds.length === 0) {
      const id = `S-${String(seq++).padStart(6, '0')}`;
      const sample = randomSample(rand, id);
      await store.add(sample);
      ref.set(id, sample);
      liveIds.push(id);
    } else if (roll < 0.8) {
      const id = liveIds[Math.floor(rand() * liveIds.length)];
      const patch = {};
      if (rand() < 0.5) patch.type = TYPES[Math.floor(rand() * TYPES.length)];
      if (rand() < 0.5) patch.date = randomDate(rand);
      if (rand() < 0.3) patch.status = 'in-use';
      if (Object.keys(patch).length === 0) patch.location = 'fridge-B1';
      await store.update(id, patch);
      ref.set(id, { ...ref.get(id), ...patch });
    } else {
      const idx = Math.floor(rand() * liveIds.length);
      const id = liveIds.splice(idx, 1)[0];
      await store.remove(id);
      ref.delete(id);
    }
  }
  return seq;
}

test('acceptance 1: 5000 mixed ops, find/scan match brute-force reference', async () => {
  const dir = tmpdir();
  const rand = prng(42);
  const ref = new Map();
  const liveIds = [];

  let store = new BiobankStore(dir);
  await runMixedWorkload(store, ref, liveIds, rand, 5000, 0);
  verifyAgainstRef(store, ref, liveIds, rand, 'before-restart');
  await store.close();

  // Reopen: recover from snapshot + WAL replay, validate indexes.
  store = new BiobankStore(dir);
  verifyAgainstRef(store, ref, liveIds, rand, 'after-restart');
  await store.close();
});

test('acceptance 2: crash mid-compact (after new files, before manifest switch)', async () => {
  const dir = tmpdir();
  const rand = prng(7);
  const ref = new Map();
  const liveIds = [];

  let store = new BiobankStore(dir);
  await runMixedWorkload(store, ref, liveIds, rand, 800, 0);

  await store.close();

  // Inject a crash at the compact commit point.
  const crashing = new BiobankStore(dir, {
    crashHook: (point) => {
      assert.equal(point, 'before-manifest-switch');
      throw new Error('simulated crash');
    },
  });
  await assert.rejects(crashing.compact(), /simulated crash/);
  crashing.wal.close(); // simulate process death: drop handles without cleanup

  // New generation files exist but the manifest still points at the old one.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generation, 1);
  assert.ok(fs.existsSync(path.join(dir, 'data-2.json')), 'new snapshot was written');
  assert.ok(fs.existsSync(path.join(dir, 'wal-2.log')), 'new WAL was written');

  // Restart: no data lost, queries still match the reference.
  store = new BiobankStore(dir);
  verifyAgainstRef(store, ref, liveIds, rand, 'after-crash-restart');

  // Compact can be retried and succeeds.
  await store.compact();
  const manifest2 = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest2.generation, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'wal-2.log'), 'utf8'), '');
  verifyAgainstRef(store, ref, liveIds, rand, 'after-recompact');
  await store.close();

  // One more restart on the compacted generation.
  store = new BiobankStore(dir);
  verifyAgainstRef(store, ref, liveIds, rand, 'after-compact-restart');
  // Writes continue to work on the new generation.
  const seq = await runMixedWorkload(store, ref, liveIds, rand, 200, 100000);
  assert.ok(seq > 100000);
  verifyAgainstRef(store, ref, liveIds, rand, 'post-compact-writes');
  await store.close();
});

test('acceptance 3: deleted index directory is rebuilt on startup, results identical', async () => {
  const dir = tmpdir();
  const rand = prng(99);
  const ref = new Map();
  const liveIds = [];

  let store = new BiobankStore(dir);
  await runMixedWorkload(store, ref, liveIds, rand, 1500, 0);
  await store.close(); // clean close persists snapshot + indexes

  // Snapshot every live record for a row-by-row comparison later.
  const before = new Map();
  {
    const s = new BiobankStore(dir);
    for (const id of liveIds) before.set(id, s.find(id));
    await s.close();
  }

  // Delete the entire index directory; startup must rebuild without error.
  const idxDirs = fs.readdirSync(dir).filter((n) => n.startsWith('indexes-'));
  assert.equal(idxDirs.length, 1);
  fs.rmSync(path.join(dir, idxDirs[0]), { recursive: true, force: true });

  store = new BiobankStore(dir);
  // Index files were rewritten by the automatic rebuild.
  assert.ok(fs.existsSync(path.join(dir, idxDirs[0], 'by_type.json')));
  assert.ok(fs.existsSync(path.join(dir, idxDirs[0], 'by_date.json')));
  // Row-by-row identical to before the deletion.
  for (const id of liveIds) {
    assert.deepEqual(store.find(id), before.get(id), `row ${id} differs after rebuild`);
  }
  verifyAgainstRef(store, ref, liveIds, rand, 'after-index-rebuild');
  await store.close();
});

test('error codes: DUP on duplicate add, NOT_FOUND on missing update/remove', async () => {
  const dir = tmpdir();
  const store = new BiobankStore(dir);
  await store.add({ id: 'A1', type: 'blood', date: '2024-01-01', location: 'f1', status: 'stored' });

  await assert.rejects(
    store.add({ id: 'A1', type: 'dna', date: '2024-02-02' }),
    (err) => err instanceof StoreError && err.code === 'DUP',
  );
  await assert.rejects(
    store.update('NOPE', { status: 'used' }),
    (err) => err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    store.remove('NOPE'),
    (err) => err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    store.add({ id: 'A2', type: 'blood', date: 'not-a-date' }),
    (err) => err.code === 'INVALID',
  );
  // Failed transactions changed nothing.
  assert.deepEqual(store.find('A1'), {
    id: 'A1', type: 'blood', date: '2024-01-01', location: 'f1', status: 'stored',
  });
  assert.equal(store.find('A2'), null);
  await store.close();
});

test('multi-op transaction is atomic: failure rolls back, nothing reaches WAL', async () => {
  const dir = tmpdir();
  const store = new BiobankStore(dir);
  await store.add({ id: 'T1', type: 'plasma', date: '2023-05-01', status: 'stored' });

  await assert.rejects(
    store.transaction((tx) => {
      tx.add({ id: 'T2', type: 'dna', date: '2023-06-01' });
      tx.update('T1', { status: 'shipped' });
      tx.remove('GHOST'); // NOT_FOUND -> whole tx aborts
    }),
    (err) => err.code === 'NOT_FOUND',
  );
  assert.equal(store.find('T2'), null);
  assert.equal(store.find('T1').status, 'stored');

  await store.transaction((tx) => {
    tx.add({ id: 'T2', type: 'dna', date: '2023-06-01' });
    tx.update('T1', { status: 'shipped' });
    tx.remove('T2');
  });
  assert.equal(store.find('T2'), null);
  assert.equal(store.find('T1').status, 'shipped');
  await store.close();
});

test('WAL recovery: uncommitted tail and torn write are ignored', async () => {
  const dir = tmpdir();
  const store = new BiobankStore(dir);
  await store.add({ id: 'W1', type: 'blood', date: '2024-03-03' });
  await store.add({ id: 'W2', type: 'tissue', date: '2024-03-04' });
  await store.close();

  // Simulate a crash: an uncommitted transaction plus garbage at the tail.
  const walPath = path.join(dir, 'wal-1.log');
  const { encodeRecord } = require('../src/wal');
  fs.appendFileSync(walPath, Buffer.concat([
    encodeRecord({ t: 'begin' }),
    encodeRecord({ t: 'put', sample: { id: 'W3', type: 'dna', date: '2024-03-05', location: '', status: '' } }),
  ]));
  fs.appendFileSync(walPath, Buffer.from('\x00\xffpartial-json{"t":"pu'));

  const reopened = new BiobankStore(dir);
  assert.ok(reopened.find('W1'));
  assert.ok(reopened.find('W2'));
  assert.equal(reopened.find('W3'), null, 'uncommitted put must not survive replay');
  // Writes still work after truncation of the torn tail.
  await reopened.add({ id: 'W4', type: 'urine', date: '2024-03-06' });
  await reopened.close();

  const again = new BiobankStore(dir);
  assert.ok(again.find('W4'));
  await again.close();
});

test('corrupt index file (checksum mismatch) triggers automatic rebuild', async () => {
  const dir = tmpdir();
  const rand = prng(5);
  const ref = new Map();
  const liveIds = [];
  let store = new BiobankStore(dir);
  await runMixedWorkload(store, ref, liveIds, rand, 300, 0);
  await store.close();

  const idxDir = fs.readdirSync(dir).find((n) => n.startsWith('indexes-'));
  const typeIdx = path.join(dir, idxDir, 'by_type.json');
  const doc = JSON.parse(fs.readFileSync(typeIdx, 'utf8'));
  doc.payload.blood = ['tampered'];
  fs.writeFileSync(typeIdx, JSON.stringify(doc)); // checksum now stale

  store = new BiobankStore(dir);
  verifyAgainstRef(store, ref, liveIds, rand, 'after-checksum-mismatch');
  await store.close();
});

test('stale index walOffset (crash before close) triggers automatic rebuild', async () => {
  const dir = tmpdir();
  let store = new BiobankStore(dir);
  await store.add({ id: 'K1', type: 'blood', date: '2024-01-01' });
  await store.close(); // indexes persisted at current walOffset

  // Simulate a crash: new store commits without close() persisting indexes.
  store = new BiobankStore(dir);
  await store.add({ id: 'K2', type: 'dna', date: '2024-01-02' });
  store.wal.close(); // drop the writer without checkpointing

  store = new BiobankStore(dir);
  assert.ok(store.find('K1'));
  assert.ok(store.find('K2'), 'WAL replay recovers the post-checkpoint commit');
  assert.deepEqual(store.scanByType('dna').map((s) => s.id), ['K2']);
  await store.close();
});
