import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, StoreError, SimulatedCrash, FROZEN, NO_VERSION, TAMPER } from '../src/store.js';
import { run as runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snapstore-test-'));
}

// Invoke the CLI in-process (the sandbox forbids spawning grandchildren
// under `node --test`); captures stdout/stderr and the exit code.
function cli(dir, args, env = {}) {
  const out = { stdout: '', stderr: '' };
  const status = runCli(['--dir', dir, ...args], {
    stdout: (s) => (out.stdout += s),
    stderr: (s) => (out.stderr += s),
    env: { SNAPSTORE_DIR: dir, ...env },
  });
  return { status, ...out };
}

// deterministic PRNG (LCG) for reproducible sampling
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('scenario 1: publishing v3 freezes its keys; untouched keys stay writable', () => {
  const dir = tmpdir();
  const store = openStore(dir);

  for (const [k, v] of [['a', '1'], ['b', '2'], ['c', '3']]) {
    const txn = store.begin();
    txn.put(k, v);
    txn.commit();
  }
  assert.equal(store.currentVersion(), 3);

  const cert = store.publish(3);
  assert.match(cert, /^[0-9a-f]{64}$/);
  assert.ok(store.isPublished(3));

  // write set touches a published key -> FROZEN
  const txn = store.begin();
  txn.put('a', 'modified');
  assert.throws(() => txn.commit(), (err) => err instanceof StoreError && err.code === FROZEN);

  // frozen constraint survives restart (WAL + cert recovery)
  store.close();
  const reopened = openStore(dir);
  const txn2 = reopened.begin();
  txn2.put('b', 'modified');
  assert.throws(() => txn2.commit(), (err) => err.code === FROZEN);

  // untouched key commits fine and gets the next monotonic version
  const txn3 = reopened.begin();
  txn3.put('d', '4');
  assert.equal(txn3.commit(), 4);

  // frozen keys still return original bytes
  assert.equal(reopened.getAt('a', 3), '1');
  reopened.close();
});

test('scenario 2: crash mid-publish (cert not durable) leaves version as draft, re-publishable', () => {
  const dir = tmpdir();

  // build v1..v3 via the CLI
  for (const [k, v] of [['x', '1'], ['y', '2'], ['z', '3']]) {
    assert.equal(cli(dir, ['put', k, v]).status, 0);
    assert.equal(cli(dir, ['commit']).status, 0);
  }

  // crash right before the certificate is written: the store is abandoned
  // without any cleanup, exactly like a power loss
  const crashed = openStore(dir, { crashMode: 'throw' });
  assert.throws(
    () => crashed.publish(3, { crashAt: 'before-cert' }),
    (err) => err instanceof SimulatedCrash,
  );
  assert.equal(fs.existsSync(path.join(dir, 'published', '3.cert')), false);
  // note: crashed.close() is never called — no flush, no cleanup

  // after "restart": version 3 must still be a draft
  const store = openStore(dir);
  assert.equal(store.isPublished(3), false);
  assert.deepEqual(store.publishedVersions(), []);

  // keys of v3 are not frozen yet
  const txn = store.begin();
  txn.put('x', 'still-draft');
  assert.equal(txn.commit(), 4);

  // re-publish succeeds
  const cert = store.publish(3);
  assert.match(cert, /^[0-9a-f]{64}$/);
  assert.ok(store.isPublished(3));
  store.close();

  // and the freeze constraint is enforced after recovery
  const reopened = openStore(dir);
  const txn2 = reopened.begin();
  txn2.put('y', 'nope');
  assert.throws(() => txn2.commit(), (err) => err.code === FROZEN);
  reopened.close();
});

test('scenario 2b: crash after cert is durable recovers as published', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const txn = store.begin();
  txn.put('k', 'v');
  txn.commit();
  store.close();

  const crashed = openStore(dir, { crashMode: 'throw' });
  assert.throws(() => crashed.publish(1, { crashAt: 'after-cert' }), SimulatedCrash);

  const reopened = openStore(dir);
  assert.ok(reopened.isPublished(1));
  const txn2 = reopened.begin();
  txn2.put('k', 'nope');
  assert.throws(() => txn2.commit(), (err) => err.code === FROZEN);
  reopened.close();
});

test('scenario 3: 10 consecutive publishes, sampled keys match publish-time snapshots', () => {
  const dir = tmpdir();
  const rng = makeRng(42);
  const store = openStore(dir);
  const references = new Map(); // version -> reference snapshot Map

  for (let round = 1; round <= 10; round++) {
    const txn = store.begin();
    const batch = 3 + Math.floor(rng() * 5);
    for (let i = 0; i < batch; i++) {
      txn.put(`r${round}-key${i}`, `value-${round}-${i}-${Math.floor(rng() * 1e6)}`);
    }
    const version = txn.commit();
    assert.equal(version, round);

    // reference snapshot taken at publish time
    const reference = new Map(store.snapshotAt(version));
    references.set(version, reference);
    store.publish(version);
  }
  assert.deepEqual(store.publishedVersions(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  store.close();

  // recover from disk, then sample random keys from every published version
  const reopened = openStore(dir);
  for (let version = 1; version <= 10; version++) {
    const reference = references.get(version);
    const keys = [...reference.keys()];
    const sampleSize = Math.max(1, Math.floor(keys.length / 2));
    for (let i = 0; i < sampleSize; i++) {
      const key = keys[Math.floor(rng() * keys.length)];
      const expected = reference.get(key);
      assert.equal(reopened.getAt(key, version), expected, `v${version} key ${key} (by version)`);
      assert.equal(
        reopened.getPublished(key, { cert: reopened.certOf(version) }),
        expected,
        `v${version} key ${key} (by cert)`,
      );
    }
    // full snapshot is byte-identical to the publish-time reference
    assert.deepEqual(reopened.snapshotAt(version), reference);
    reopened.verify({ version });
  }
  reopened.close();
});

test('NO_VERSION for unknown versions and certificates', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const txn = store.begin();
  txn.put('a', '1');
  txn.commit();

  assert.throws(() => store.getAt('a', 99), (err) => err.code === NO_VERSION);
  assert.throws(() => store.publish(99), (err) => err.code === NO_VERSION);
  assert.throws(() => store.verify({ version: 1 }), (err) => err.code === NO_VERSION); // not published
  assert.throws(() => store.versionForCert('0'.repeat(64)), (err) => err.code === NO_VERSION);
  store.close();
});

test('TAMPER when stored content no longer matches the certificate', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const txn = store.begin();
  txn.put('a', 'original');
  txn.commit();
  const cert = store.publish(1);
  store.close();

  // tamper with the WAL: rewrite the committed value
  const walPath = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(walPath, 'utf8').split('\n').filter(Boolean);
  const commitRec = JSON.parse(lines.find((l) => JSON.parse(l).type === 'commit'));
  commitRec.writes.a = 'forged';
  const out = lines.map((l) => {
    const rec = JSON.parse(l);
    return JSON.stringify(rec.type === 'commit' ? commitRec : rec);
  }).join('\n') + '\n';
  fs.writeFileSync(walPath, out);

  const reopened = openStore(dir);
  assert.throws(() => reopened.verify({ version: 1 }), (err) => err.code === TAMPER);
  assert.throws(() => reopened.verify({ cert }), (err) => err.code === TAMPER);
  assert.throws(() => reopened.getPublished('a', { version: 1 }), (err) => err.code === TAMPER);
  reopened.close();
});

test('reads by version and by cert are byte-identical to publish-time content', () => {
  const dir = tmpdir();
  const store = openStore(dir);
  const txn = store.begin();
  txn.put('utf8', 'héllo ✓ 数据');
  txn.put('newlines', 'a\nb\tc');
  txn.commit();
  const cert = store.publish(1);
  store.close();

  const reopened = openStore(dir);
  assert.equal(reopened.getAt('utf8', 1), 'héllo ✓ 数据');
  assert.equal(reopened.getPublished('newlines', { cert }), 'a\nb\tc');
  assert.equal(reopened.getPublished('utf8', { version: 1 }), reopened.getAt('utf8', 1));
  reopened.close();
});

test('CLI end-to-end: put/commit/publish/get/verify and error conventions', () => {
  const dir = tmpdir();

  assert.equal(cli(dir, ['put', 'a', '1']).status, 0);
  let res = cli(dir, ['commit']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /version 1/);

  assert.equal(cli(dir, ['put', 'b', '2']).status, 0);
  assert.equal(cli(dir, ['commit']).status, 0);

  res = cli(dir, ['publish', '2']);
  assert.equal(res.status, 0);
  const cert = /cert ([0-9a-f]{64})/.exec(res.stdout)[1];

  res = cli(dir, ['get', 'a', '--version', '2']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '1\n');

  res = cli(dir, ['get', 'b', '--cert', cert]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '2\n');

  res = cli(dir, ['verify', '--cert', cert]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^OK version 2/);

  // FROZEN via CLI
  assert.equal(cli(dir, ['put', 'a', 'changed']).status, 0);
  res = cli(dir, ['commit']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /^FROZEN:/);

  // NO_VERSION via CLI
  res = cli(dir, ['get', 'a', '--version', '42']);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /^NO_VERSION:/);

  // untouched key still writable via CLI
  assert.equal(cli(dir, ['discard']).status, 0); // drop the frozen 'a' write
  assert.equal(cli(dir, ['put', 'fresh', 'ok']).status, 0);
  res = cli(dir, ['commit']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /version 3/);
});
