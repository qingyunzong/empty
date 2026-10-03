import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MVCCStore, MvccError } from '../src/mvcc.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-test-'));
}

function dump(tx) {
  return [...tx.entries()].map(([k, v]) => [k, v.toString('utf8')]);
}

test('acceptance 1: long read txn is stable across 5 commits', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  store.transact((tx) => {
    tx.set('alpha', '1');
    tx.set('beta', '1');
  });
  const reader = store.beginRead();
  const before = dump(reader);
  for (let i = 0; i < 5; i += 1) {
    store.transact((tx) => {
      tx.set('alpha', `v${i}`);
      tx.set(`extra${i}`, 'x');
      tx.delete('beta');
    });
  }
  assert.deepEqual(dump(reader), before);
  assert.deepEqual(dump(reader), [
    ['alpha', '1'],
    ['beta', '1'],
  ]);
  assert.equal(reader.get('alpha').toString(), '1');
  assert.equal(reader.snapshotSeq, 1);
  reader.close();
  const fresh = store.beginRead();
  assert.equal(fresh.get('alpha').toString(), 'v4');
  assert.equal(fresh.get('beta'), null);
  fresh.close();
  store.close();
});

test('acceptance 2: tagged snapshot reads are byte-identical after later writes', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  store.transact((tx) => {
    tx.set('gene', Buffer.from([0x00, 0xff, 0x61, 0xe4, 0xb8, 0xad]));
    tx.set('count', '42');
  });
  const first = store.beginRead();
  const firstDump = [...first.entries()].map(([k, v]) => [k, Buffer.from(v)]);
  first.close();
  store.snapshot('exp-2024-06');
  store.transact((tx) => tx.set('gene', 'mutated'));
  store.transact((tx) => tx.delete('count'));
  store.transact((tx) => tx.set('gene', 'mutated-again'));
  const replay = store.beginRead({ tag: 'exp-2024-06' });
  const replayDump = [...replay.entries()].map(([k, v]) => [k, Buffer.from(v)]);
  replay.close();
  assert.equal(replayDump.length, firstDump.length);
  for (let i = 0; i < firstDump.length; i += 1) {
    assert.equal(replayDump[i][0], firstDump[i][0]);
    assert.ok(Buffer.compare(replayDump[i][1], firstDump[i][1]) === 0, 'byte-identical value');
  }
  store.close();
});

test('write conflict: first-writer-wins, CONFLICT is safe to retry', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  store.transact((tx) => tx.set('k', 'base'));
  const txA = store.beginWrite();
  const txB = store.beginWrite();
  txA.set('k', 'A');
  txB.set('k', 'B');
  txA.commit();
  assert.throws(() => txB.commit(), (err) => err instanceof MvccError && err.code === 'CONFLICT');
  // Nothing from txB was applied.
  const r1 = store.beginRead();
  assert.equal(r1.get('k').toString(), 'A');
  r1.close();
  // Retry with a fresh transaction succeeds.
  const seq = store.transact((tx) => tx.set('k', 'B-retry'));
  const r2 = store.beginRead();
  assert.equal(r2.get('k').toString(), 'B-retry');
  assert.equal(r2.snapshotSeq, seq);
  r2.close();
  // Non-overlapping write sets do not conflict.
  const txC = store.beginWrite();
  const txD = store.beginWrite();
  txC.set('c', '1');
  txD.set('d', '2');
  txC.commit();
  txD.commit();
  store.close();
});

test('unknown tag raises NO_TAG', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  assert.throws(
    () => store.beginRead({ tag: 'nope' }),
    (err) => err instanceof MvccError && err.code === 'NO_TAG',
  );
  store.close();
});

test('gc refuses to reclaim versions referenced by tags or active readers', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  for (let i = 1; i <= 6; i += 1) store.transact((tx) => tx.set('k', `v${i}`));
  store.snapshot('keep'); // seq 6
  store.transact((tx) => tx.set('k', 'v7'));
  const reader = store.beginRead(); // seq 7
  store.transact((tx) => tx.set('k', 'v8'));
  assert.throws(
    () => store.gc(8),
    (err) => err instanceof MvccError && err.code === 'GC_REFUSED',
  );
  assert.throws(
    () => store.gc(),
    (err) => err instanceof MvccError && err.code === 'GC_REFUSED',
  );
  // A horizon at or below the oldest protected snapshot is allowed.
  const collected = store.gc(6);
  assert.ok(collected > 0);
  reader.close();
  const tagged = store.beginRead({ tag: 'keep' });
  assert.equal(tagged.get('k').toString(), 'v6');
  tagged.close();
  const current = store.beginRead();
  assert.equal(current.get('k').toString(), 'v8');
  current.close();
  store.close();
});

test('gc with no tags/readers collects old versions, keeps current state', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  for (let i = 1; i <= 10; i += 1) store.transact((tx) => tx.set('k', `v${i}`));
  const collected = store.gc();
  assert.equal(collected, 9);
  const tx = store.beginRead();
  assert.equal(tx.get('k').toString(), 'v10');
  tx.close();
  store.close();
});

test('crash recovery: tags and version chains survive reopen', () => {
  const dir = tmpdir();
  let store = MVCCStore.open(dir);
  store.transact((tx) => tx.set('a', '1'));
  store.transact((tx) => tx.set('a', '2'));
  store.snapshot('before-crash');
  store.transact((tx) => tx.set('a', '3'));
  // Simulate a crash: no close(), every record was fsynced already.
  store = MVCCStore.open(dir);
  assert.equal(store.seq, 3);
  const tagged = store.beginRead({ tag: 'before-crash' });
  assert.equal(tagged.get('a').toString(), '2');
  tagged.close();
  const current = store.beginRead();
  assert.equal(current.get('a').toString(), '3');
  current.close();
  // Version chain intact: all three versions present.
  assert.deepEqual(
    store.versions.get('a').map((v) => [v.seq, v.value.toString()]),
    [
      [1, '1'],
      [2, '2'],
      [3, '3'],
    ],
  );
  store.close();
});

test('recovery truncates a torn trailing WAL record', () => {
  const dir = tmpdir();
  let store = MVCCStore.open(dir);
  store.transact((tx) => tx.set('a', '1'));
  store.snapshot('t1');
  store.close();
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"t":"commit","seq":2,"writes":[["a","'); // torn
  store = MVCCStore.open(dir);
  assert.equal(store.seq, 1);
  const tx = store.beginRead({ tag: 't1' });
  assert.equal(tx.get('a').toString(), '1');
  tx.close();
  // Appends after recovery still work.
  store.transact((w) => w.set('a', '2'));
  store.close();
  store = MVCCStore.open(dir);
  assert.equal(store.seq, 2);
  const tx2 = store.beginRead({ tag: 't1' });
  assert.equal(tx2.get('a').toString(), '1');
  tx2.close();
  store.close();
});

test('gc checkpoint persists: tags remain readable after gc + reopen', () => {
  const dir = tmpdir();
  let store = MVCCStore.open(dir);
  for (let i = 1; i <= 5; i += 1) store.transact((tx) => tx.set('k', `v${i}`));
  store.snapshot('mid'); // seq 5
  for (let i = 6; i <= 9; i += 1) store.transact((tx) => tx.set('k', `v${i}`));
  store.gc(5);
  store.close();
  store = MVCCStore.open(dir);
  const tagged = store.beginRead({ tag: 'mid' });
  assert.equal(tagged.get('k').toString(), 'v5');
  tagged.close();
  const current = store.beginRead();
  assert.equal(current.get('k').toString(), 'v9');
  current.close();
  store.close();
});

// Reference model that keeps every version forever.
class Model {
  constructor() {
    this.hist = new Map(); // key -> [{seq, value:string|null}]
    this.tags = new Map();
    this.seq = 0;
  }

  commit(writes) {
    const seq = ++this.seq;
    for (const [key, value] of writes) {
      if (!this.hist.has(key)) this.hist.set(key, []);
      this.hist.get(key).push({ seq, value });
    }
    return seq;
  }

  tag(name) {
    this.tags.set(name, this.seq);
  }

  dumpAt(seq) {
    const out = [];
    for (const key of [...this.hist.keys()].sort()) {
      const chain = this.hist.get(key);
      let value;
      for (const version of chain) {
        if (version.seq <= seq) value = version.value;
        else break;
      }
      if (value !== undefined && value !== null) out.push([key, value]);
    }
    return out;
  }
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('acceptance 3: randomized ops + gc match a keep-everything reference model', () => {
  const dir = tmpdir();
  const store = MVCCStore.open(dir);
  const model = new Model();
  const rand = lcg(0x5eed);
  const keys = Array.from({ length: 12 }, (_, i) => `key${i}`);
  const openReaders = []; // [{tx, seq}]
  let tagCount = 0;

  const checkTag = (name) => {
    const tx = store.beginRead({ tag: name });
    const actual = dump(tx);
    tx.close();
    assert.deepEqual(actual, model.dumpAt(model.tags.get(name)), `tag ${name} mismatch`);
  };

  for (let step = 0; step < 600; step += 1) {
    const roll = rand();
    if (roll < 0.4) {
      // batch commit of 1-4 writes/deletes
      const writes = [];
      const n = 1 + Math.floor(rand() * 4);
      const tx = store.beginWrite();
      for (let i = 0; i < n; i += 1) {
        const key = keys[Math.floor(rand() * keys.length)];
        if (rand() < 0.2) {
          tx.delete(key);
          writes.push([key, null]);
        } else {
          const value = `v${step}:${i}:${Math.floor(rand() * 1e6)}`;
          tx.set(key, value);
          writes.push([key, value]);
        }
      }
      const seq = tx.commit();
      assert.equal(model.commit(writes), seq);
    } else if (roll < 0.55) {
      const name = `tag${tagCount}`;
      tagCount += 1;
      assert.equal(store.snapshot(name), model.seq);
      model.tag(name);
    } else if (roll < 0.7) {
      // open a read txn (current or tagged) and keep it alive
      if (openReaders.length >= 6) {
        const victim = openReaders.splice(Math.floor(rand() * openReaders.length), 1)[0];
        victim.tx.close();
      }
      if (tagCount > 0 && rand() < 0.5) {
        const name = `tag${Math.floor(rand() * tagCount)}`;
        const tx = store.beginRead({ tag: name });
        openReaders.push({ tx, seq: model.tags.get(name) });
      } else {
        const tx = store.beginRead();
        openReaders.push({ tx, seq: tx.snapshotSeq });
      }
    } else if (roll < 0.85) {
      // verify a random open reader against the model
      if (openReaders.length > 0) {
        const { tx, seq } = openReaders[Math.floor(rand() * openReaders.length)];
        assert.deepEqual(dump(tx), model.dumpAt(seq), `reader at seq ${seq} mismatch`);
      }
    } else {
      // gc with a random horizon; refusal must agree with the protection rule
      const before = Math.floor(rand() * (store.seq + 1));
      const protectedSeqs = [...model.tags.values(), ...openReaders.map((r) => r.seq)];
      const shouldRefuse = protectedSeqs.length > 0 && before > Math.min(...protectedSeqs);
      if (shouldRefuse) {
        assert.throws(
          () => store.gc(before),
          (err) => err instanceof MvccError && err.code === 'GC_REFUSED',
        );
      } else {
        store.gc(before);
      }
    }
  }

  // After all gc runs, every tag snapshot must still be fully readable.
  for (const name of model.tags.keys()) checkTag(name);
  // Open readers still see their pinned snapshots.
  for (const { tx, seq } of openReaders) {
    assert.deepEqual(dump(tx), model.dumpAt(seq));
    tx.close();
  }
  // Current state matches too.
  const tx = store.beginRead();
  assert.deepEqual(dump(tx), model.dumpAt(model.seq));
  tx.close();

  // And everything still matches after a crash-style reopen.
  store.close();
  const reopened = MVCCStore.open(dir);
  for (const name of model.tags.keys()) {
    const rtx = reopened.beginRead({ tag: name });
    assert.deepEqual(dump(rtx), model.dumpAt(model.tags.get(name)), `tag ${name} after reopen`);
    rtx.close();
  }
  reopened.close();
});
