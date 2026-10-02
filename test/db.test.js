import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DCDB, DBError, canonicalize, certHash } from '../src/db.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-test-'));
}

// NOTE: this sandbox drops piped stdout of grandchild node processes, so
// capture CLI output via temp files instead of spawnSync pipes.
function runCli(dir, args, env = {}) {
  const outFile = path.join(dir, '.cli-out.txt');
  const errFile = path.join(dir, '.cli-err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [CLI, '--dir', dir, ...args], {
    stdio: ['ignore', outFd, errFd],
    env: { ...process.env, ...env },
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

test('scenario 1: publishing v3 freezes its keys; unrelated keys stay writable', () => {
  const dir = tmpdir();
  const db = DCDB.open(dir);

  for (const [k, v] of [['a', '1'], ['b', '2'], ['c', '3']]) {
    const tx = db.begin();
    tx.put(k, v);
    tx.commit();
  }
  assert.equal(db.currentVersion, 3);

  const rec = db.publish(3);
  assert.match(rec.cert, /^[0-9a-f]{64}$/);

  // writing a key contained in published v3 -> FROZEN
  for (const frozenKey of ['a', 'b', 'c']) {
    const tx = db.begin();
    tx.put(frozenKey, 'modified');
    assert.throws(() => tx.commit(), (err) => err instanceof DBError && err.code === 'FROZEN');
  }
  assert.equal(db.get({ version: 3 }).get('a'), '1'); // unchanged

  // writing an untouched key -> OK
  const tx = db.begin();
  tx.put('d', '4');
  assert.equal(tx.commit(), 4);

  // freeze constraint survives restart (WAL + certs replay)
  const reopened = DCDB.open(dir);
  const tx2 = reopened.begin();
  tx2.put('b', 'nope');
  assert.throws(() => tx2.commit(), (err) => err.code === 'FROZEN');
  const tx3 = reopened.begin();
  tx3.put('e', '5');
  assert.equal(tx3.commit(), 5);
});

test('scenario 2: crash mid-publish (cert not on disk) leaves version as draft, re-publish works', () => {
  const dir = tmpdir();
  assert.equal(runCli(dir, ['put', 'paper', 'draft-1']).status, 0);
  const commit = runCli(dir, ['commit']);
  assert.equal(commit.status, 0, commit.stderr);
  assert.match(commit.stdout, /committed version 1/);

  // crash right before the certificate is written
  const crashed = runCli(dir, ['publish', '1'], { DCDB_CRASH_AT: 'before-cert' });
  assert.equal(crashed.status, 137);

  // after restart: no cert file, no effective publish, key not frozen
  assert.equal(fs.readdirSync(path.join(dir, 'certs')).length, 0);
  const db = DCDB.open(dir);
  assert.equal(db.versionToCert.size, 0);
  assert.equal(db.frozenKeys.size, 0);

  // re-publish succeeds and freeze kicks in
  const repub = runCli(dir, ['publish', '1']);
  assert.equal(repub.status, 0, repub.stderr);
  const cert = /cert ([0-9a-f]{64})/.exec(repub.stdout)[1];

  const frozen = runCli(dir, ['put', 'paper', 'draft-2']);
  assert.equal(frozen.status, 0);
  const frozenCommit = runCli(dir, ['commit']);
  assert.equal(frozenCommit.status, 1);
  assert.match(frozenCommit.stderr, /ERROR FROZEN/);

  const verify = runCli(dir, ['verify', '--cert', cert]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /OK/);
});

test('scenario 3: 10 consecutive publishes, sampled keys match publish-time snapshots', () => {
  const dir = tmpdir();
  const db = DCDB.open(dir);
  const reference = new Map();
  const publishedRefs = new Map(); // version -> {cert, snapshot:Map}
  let rngState = 42;
  const rand = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let round = 0; round < 10; round++) {
    const tx = db.begin();
    const nWrites = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < nWrites; i++) {
      const key = `k${Math.floor(rand() * 1000)}-${round}-${i}`;
      const value = `v${Math.floor(rand() * 1e9)}`;
      tx.put(key, value);
      reference.set(key, value);
    }
    const version = tx.commit();
    const rec = db.publish(version);
    publishedRefs.set(version, { cert: rec.cert, snapshot: new Map(reference) });
  }
  assert.equal(db.currentVersion, 10);

  // reopen from disk so reads go through WAL/cert recovery
  const reopened = DCDB.open(dir);
  for (const [version, ref] of publishedRefs) {
    const byVersion = reopened.get({ version });
    const byCert = reopened.get({ cert: ref.cert });
    // byte-identical canonical output via both read paths
    assert.equal(canonicalize(byVersion), canonicalize(ref.snapshot));
    assert.equal(canonicalize(byCert), canonicalize(ref.snapshot));
    // random sampling of keys against the publish-time reference
    const keys = [...ref.snapshot.keys()];
    for (let s = 0; s < Math.min(10, keys.length); s++) {
      const k = keys[Math.floor(rand() * keys.length)];
      assert.equal(byVersion.get(k), ref.snapshot.get(k));
      assert.equal(byCert.get(k), ref.snapshot.get(k));
    }
    assert.equal(certHash(byVersion), ref.cert);
    assert.equal(reopened.verify({ version }), true);
    assert.equal(reopened.verify({ cert: ref.cert }), true);
  }
});

test('error conventions: NO_VERSION and TAMPER', () => {
  const dir = tmpdir();
  const db = DCDB.open(dir);
  const tx = db.begin();
  tx.put('x', '1');
  tx.commit();
  const rec = db.publish(1);

  assert.throws(() => db.get({ version: 99 }), (e) => e.code === 'NO_VERSION');
  assert.throws(() => db.get({ cert: '0'.repeat(64) }), (e) => e.code === 'NO_VERSION');
  assert.throws(() => db.publish(99), (e) => e.code === 'NO_VERSION');

  // tamper with the cert file on disk -> TAMPER
  const certFile = path.join(dir, 'certs', `${rec.cert}.json`);
  const tampered = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  tampered.snapshot.x = 'evil';
  fs.writeFileSync(certFile, JSON.stringify(tampered));
  assert.throws(() => db.verify({ cert: rec.cert }), (e) => e.code === 'TAMPER');
  assert.throws(() => db.verify({ version: 1 }), (e) => e.code === 'TAMPER');

  // CLI surfaces the same codes
  const bad = runCli(dir, ['get', '--version', '99']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /ERROR NO_VERSION/);
  const tamper = runCli(dir, ['verify', '--version', '1']);
  assert.equal(tamper.status, 1);
  assert.match(tamper.stderr, /ERROR TAMPER/);
});

test('CLI end-to-end: put/commit/publish/get round trip', () => {
  const dir = tmpdir();
  runCli(dir, ['put', 'title', 'paper-a']);
  runCli(dir, ['put', 'year', '2026']);
  const out = runCli(dir, ['commit']);
  assert.match(out.stdout, /committed version 1/);
  const pub = runCli(dir, ['publish', '1']);
  const cert = /cert ([0-9a-f]{64})/.exec(pub.stdout)[1];

  const byVersion = runCli(dir, ['get', '--version', '1']);
  const byCert = runCli(dir, ['get', '--cert', cert]);
  const expected = '"title"="paper-a"\n"year"="2026"\n';
  assert.equal(byVersion.stdout, expected);
  assert.equal(byCert.stdout, expected);
  assert.equal(byVersion.stdout, byCert.stdout); // byte-identical
});
