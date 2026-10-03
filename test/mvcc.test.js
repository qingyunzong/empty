import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MvccStore, MvccError } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mvcc-test-'));
}

test('acceptance 1: long read tx is stable across 5 concurrent commits', () => {
  const dir = tmpdir();
  const store = MvccStore.open(dir);
  store.commit({ a: 'v0', b: 'keep' });

  const reader = store.begin();
  const before = { a: reader.get('a'), b: reader.get('b') };

  for (let i = 1; i <= 5; i++) {
    store.commit({ a: `v${i}`, [`new${i}`]: `x${i}` });
  }
  assert.equal(store.commitSeq, 6);

  assert.deepEqual(reader.get('a'), before.a);
  assert.deepEqual(reader.get('b'), before.b);
  assert.equal(reader.get('new1'), undefined);
  assert.deepEqual(reader.keys(), ['a', 'b']);

  const fresh = store.begin();
  assert.equal(fresh.get('a').toString(), 'v5');
  assert.equal(fresh.get('new5').toString(), 'x5');
  reader.close();
  fresh.close();
  store.close();
});

test('acceptance 2: tagged snapshot reads are byte-identical after later writes', () => {
  const dir = tmpdir();
  const store = MvccStore.open(dir);
  const blob = Buffer.from([0, 1, 2, 255, 254, 13, 10]); // binary, byte-exact check
  store.commit({ doc: blob, meta: 'first' });

  const first = store.begin();
  const firstBytes = Buffer.from(first.get('doc'));
  first.close();

  store.tag('experiment-1');

  store.commit({ doc: 'mutated', meta: 'second' });
  store.commit({ doc: Buffer.alloc(64, 7), extra: 'noise' });
  store.commit({ meta: null }); // delete

  const tx = store.beginTag('experiment-1');
  assert.deepEqual(tx.get('doc'), firstBytes);
  assert.ok(tx.get('doc').equals(blob));
  assert.equal(tx.get('meta').toString(), 'first');
  assert.equal(tx.get('extra'), undefined);
  tx.close();
  store.close();
});

test('first-writer-wins conflict returns CONFLICT and retry succeeds', () => {
  const dir = tmpdir();
  const store = MvccStore.open(dir);
  store.commit({ k: 'init' });

  const tx1 = store.beginWrite();
  const tx2 = store.beginWrite();
  tx1.set('k', 'from-tx1');
  tx2.set('k', 'from-tx2');
  tx1.commit();

  assert.throws(() => tx2.commit(), (err) => err instanceof MvccError && err.code === 'CONFLICT');

  // Safe retry: fresh snapshot, reapply, commit.
  const tx3 = store.beginWrite();
  tx3.set('k', 'from-tx2');
  tx3.commit();

  const tx = store.begin();
  assert.equal(tx.get('k').toString(), 'from-tx2');
  tx.close();

  // Disjoint writes do not conflict.
  const a = store.beginWrite();
  const b = store.beginWrite();
  a.set('x', '1');
  b.set('y', '2');
  a.commit();
  b.commit();
  store.close();
});

test('missing tag raises NO_TAG', () => {
  const dir = tmpdir();
  const store = MvccStore.open(dir);
  store.commit({ a: '1' });
  assert.throws(() => store.beginTag('nope'), (err) => err.code === 'NO_TAG');
  assert.throws(() => store.untag('nope'), (err) => err.code === 'NO_TAG');
  store.close();
});

test('WAL recovery: tags and version chains survive close/reopen and crash', () => {
  const dir = tmpdir();
  const store = MvccStore.open(dir);
  store.commit({ a: 'v1' });
  store.tag('release-1');
  store.commit({ a: 'v2', b: 'x' });
  store.tag('release-2');
  store.commit({ a: 'v3' });
  store.close();

  // Clean reopen.
  const reopened = MvccStore.open(dir);
  assert.equal(reopened.commitSeq, 3);
  assert.equal(reopened.beginTag('release-1').get('a').toString(), 'v1');
  assert.equal(reopened.beginTag('release-2').get('a').toString(), 'v2');
  assert.equal(reopened.begin().get('a').toString(), 'v3');

  // Simulated crash: no close(), a second opener must replay the same WAL.
  reopened.commit({ a: 'v4' });
  reopened.tag('release-3');
  const crashed = MvccStore.open(dir);
  assert.equal(crashed.commitSeq, 4);
  assert.equal(crashed.beginTag('release-3').get('a').toString(), 'v4');
  assert.equal(crashed.beginTag('release-1').get('a').toString(), 'v1');
  crashed.close();
  reopened.close();
});

test('gc keeps tagged snapshots readable and refuses to collect referenced versions', () => {
  const dir = tmpdir();
  const store = MvccStore.open(dir);
  for (let i = 1; i <= 10; i++) store.commit({ k: `v${i}`, other: `o${i}` });
  store.tag('at-5', 5);

  const longRead = store.begin(); // pins seq 10
  store.commit({ k: 'v11' }); // seq 11

  // GC must refuse to collect versions still referenced by the tag.
  assert.throws(() => store.gc(8), (err) => err.code === 'GC_REFUSED');

  const collected = store.gc();
  assert.ok(collected > 0);

  // Tag snapshot still fully readable.
  const tagged = store.beginTag('at-5');
  assert.equal(tagged.get('k').toString(), 'v5');
  assert.equal(tagged.get('other').toString(), 'o5');
  tagged.close();

  // Active long read unaffected.
  assert.equal(longRead.get('k').toString(), 'v10');
  longRead.close();

  // GC state survives recovery (checkpoint record).
  store.close();
  const reopened = MvccStore.open(dir);
  assert.equal(reopened.beginTag('at-5').get('k').toString(), 'v5');
  assert.equal(reopened.begin().get('k').toString(), 'v11');
  reopened.close();
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 3: randomized ops with gc match a full-history reference model', () => {
  const dir = tmpdir();
  const rand = mulberry32(20261004);
  const store = MvccStore.open(dir);

  // Reference model: keeps every version forever.
  const model = {
    seq: 0,
    hist: new Map(), // key -> [{seq, value:Buffer|null}]
    tags: new Map(),
    getAt(key, seq) {
      const arr = this.hist.get(key);
      if (!arr) return undefined;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].seq <= seq) return arr[i].value === null ? undefined : arr[i].value;
      }
      return undefined;
    },
  };

  const keys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const openReads = []; // { tx, seq }
  let tagCounter = 0;

  const verifyTag = (name) => {
    const seq = model.tags.get(name);
    const tx = store.beginTag(name);
    for (const key of keys) {
      const expected = model.getAt(key, seq);
      const actual = tx.get(key);
      if (expected === undefined) assert.equal(actual, undefined, `${name}/${key}`);
      else assert.ok(actual && actual.equals(expected), `${name}/${key} @${seq}`);
    }
    tx.close();
  };

  const verifyOpenReads = () => {
    for (const { tx, seq } of openReads) {
      for (const key of keys) {
        const expected = model.getAt(key, seq);
        const actual = tx.get(key);
        if (expected === undefined) assert.equal(actual, undefined);
        else assert.ok(actual && actual.equals(expected));
      }
    }
  };

  for (let step = 0; step < 400; step++) {
    const op = rand();
    if (op < 0.4) {
      // random commit of 1-3 writes/deletes
      const writes = {};
      const n = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < n; j++) {
        const key = keys[Math.floor(rand() * keys.length)];
        writes[key] =
          rand() < 0.2 ? null : Buffer.from(`s${model.seq + 1}-${Math.floor(rand() * 1e6)}`);
      }
      const seq = store.commit(writes);
      assert.equal(seq, model.seq + 1);
      model.seq = seq;
      for (const [k, v] of Object.entries(writes)) {
        if (!model.hist.has(k)) model.hist.set(k, []);
        model.hist.get(k).push({ seq, value: v === null ? null : Buffer.from(v) });
      }
    } else if (op < 0.55) {
      const name = `tag-${tagCounter++}`;
      store.tag(name);
      model.tags.set(name, model.seq);
    } else if (op < 0.65) {
      const tx = store.begin();
      openReads.push({ tx, seq: tx.snapshotSeq });
    } else if (op < 0.75 && openReads.length > 0) {
      const idx = Math.floor(rand() * openReads.length);
      openReads[idx].tx.close();
      openReads.splice(idx, 1);
    } else if (op < 0.9) {
      store.gc(); // must never break tags or pinned reads
    } else {
      for (const name of model.tags.keys()) verifyTag(name);
      verifyOpenReads();
    }
  }

  // Final full verification, including after recovery.
  for (const name of model.tags.keys()) verifyTag(name);
  verifyOpenReads();
  for (const { tx } of openReads) tx.close();
  store.gc();
  store.close();

  const reopened = MvccStore.open(dir);
  for (const [name, seq] of model.tags) {
    const tx = reopened.beginTag(name);
    for (const key of keys) {
      const expected = model.getAt(key, seq);
      const actual = tx.get(key);
      if (expected === undefined) assert.equal(actual, undefined);
      else assert.ok(actual && actual.equals(expected));
    }
    tx.close();
  }
  reopened.close();
});
