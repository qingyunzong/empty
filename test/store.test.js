'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EvidenceStore, StoreError, GENESIS_HASH } = require('../src/store');
const cli = require('../bin/cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evstore-'));
}

// Drive the CLI in-process, capturing output and the exit code.
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = cli.run(args, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { status, stdout, stderr };
}

function rec(id, submitter, timestamp, payload) {
  return { id, submitter, timestamp, payload };
}

// Locate the byte offsets of every frame in data.log.
function frameOffsets(dataPath) {
  const buf = fs.readFileSync(dataPath);
  const offsets = [];
  let offset = 0;
  while (offset < buf.length) {
    offsets.push(offset);
    const len = buf.readUInt32BE(offset);
    offset += 4 + len;
  }
  return offsets;
}

test('scenario 1: three batches commit, verify passes, certs independently verifiable', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);

  const c1 = store.commit([rec('e1', 'alice', 1000, 'alpha'), rec('e2', 'alice', 1001, 'beta')]);
  const c2 = store.commit([rec('e3', 'bob', 2000, 'gamma')]);
  const c3 = store.commit([rec('e4', 'alice', 3000, 'delta'), rec('e5', 'carol', 3001, 'eps')]);

  const report = store.verify();
  assert.equal(report.ok, true);
  assert.equal(report.recordCount, 5);
  assert.equal(report.batchCount, 3);
  assert.equal(report.chainHead, c3.chainHead);

  // Chain links batches: batch N's prevChainHead is batch N-1's chainHead.
  assert.equal(c1.prevChainHead, GENESIS_HASH);
  assert.equal(c2.prevChainHead, c1.chainHead);
  assert.equal(c3.prevChainHead, c2.chainHead);

  // Certificate files exist on disk and match what commit returned.
  for (const cert of [c1, c2, c3]) {
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'certs', cert.batchId + '.json'), 'utf8'));
    assert.deepEqual(onDisk, cert);
  }

  // CLI: verify passes and cert can be exported for independent checking.
  const v = runCli(['verify', '--db', dir]);
  assert.equal(v.status, 0, v.stderr);
  const exported = runCli(['cert', '--db', dir, '--batch', c2.batchId]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).chainHead, c2.chainHead);

  // Independent verification: recompute the chain from raw data.log bytes and
  // confirm the batch chain head equals the exported certificate.
  const crypto = require('node:crypto');
  const buf = fs.readFileSync(path.join(dir, 'data.log'));
  let offset = 0;
  let prev = Buffer.alloc(32);
  const heads = new Map();
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const r = JSON.parse(buf.subarray(offset + 4, offset + 4 + len).toString('utf8'));
    const content = Buffer.from(JSON.stringify({
      id: r.id, submitter: r.submitter, timestamp: r.timestamp, payload: r.payload,
    }), 'utf8');
    const h = crypto.createHash('sha256').update(prev).update(content).digest();
    assert.equal(h.toString('hex'), r.hash);
    heads.set(r.batchId, r.hash);
    prev = h;
    offset += 4 + len;
  }
  assert.equal(heads.get(c2.batchId), JSON.parse(exported.stdout).chainHead);
});

test('scenario 2: one-byte tamper is detected as TAMPER with the correct offset', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  store.commit([rec('e1', 'alice', 1000, 'first-payload')]);
  store.commit([rec('e2', 'bob', 2000, 'second-payload')]);
  store.commit([rec('e3', 'carol', 3000, 'third-payload')]);

  const dataPath = path.join(dir, 'data.log');
  const offsets = frameOffsets(dataPath);
  assert.equal(offsets.length, 3);

  // Flip one byte inside the second record's payload (keeps JSON valid).
  const buf = fs.readFileSync(dataPath);
  const needle = Buffer.from('second-payload');
  const pos = buf.indexOf(needle);
  assert.ok(pos > offsets[1] && pos < offsets[2]);
  buf[pos] = buf[pos] ^ 0x01;
  fs.writeFileSync(dataPath, buf);

  // API verify reports TAMPER at the second record's frame offset.
  const store2 = new EvidenceStore(dir);
  assert.throws(
    () => store2.verify(),
    (err) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err.code, 'TAMPER');
      assert.equal(err.offset, offsets[1]);
      assert.equal(err.recordId, 'e2');
      return true;
    }
  );

  // CLI verify exits non-zero and names TAMPER plus the offset.
  const v = runCli(['verify', '--db', dir]);
  assert.equal(v.status, 2);
  assert.match(v.stderr, /TAMPER/);
  assert.match(v.stderr, new RegExp(`offset ${offsets[1]}`));

  // Reading the tampered record directly also fails.
  assert.throws(() => store2.get('e2'), (err) => err.code === 'TAMPER');
});

test('scenario 3: crash before cert write makes the batch invisible, prior certs stay valid', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  const c1 = store.commit([rec('e1', 'alice', 1000, 'committed-1')]);
  const c2 = store.commit([rec('e2', 'bob', 2000, 'committed-2')]);

  // Simulate a crash after the data.log fsync but before the certificate
  // write: the commit aborts abruptly, leaving WAL + uncommitted tail behind.
  const crashing = new EvidenceStore(dir, {
    beforeCertWrite: () => {
      throw new Error('simulated crash');
    },
  });
  assert.throws(
    () => crashing.commit([rec('e3', 'mallory', 3000, 'uncommitted')]),
    /simulated crash/
  );
  // On-disk state at "crash" time: WAL present, data.log tail uncertified.
  assert.equal(fs.existsSync(path.join(dir, 'wal.log')), true);

  // Reopen: recovery truncates the uncommitted tail and drops the WAL.
  const reopened = new EvidenceStore(dir);
  assert.equal(reopened.get('e3'), null);
  assert.deepEqual(reopened.list().map((r) => r.id), ['e1', 'e2']);
  assert.equal(fs.existsSync(path.join(dir, 'wal.log')), false);

  // Whole-database verify still passes and prior certificates are intact.
  const report = reopened.verify();
  assert.equal(report.ok, true);
  assert.equal(report.recordCount, 2);
  assert.equal(report.batchCount, 2);
  assert.equal(report.chainHead, c2.chainHead);
  assert.deepEqual(reopened.cert(c1.batchId), c1);
  assert.deepEqual(reopened.cert(c2.batchId), c2);

  const v = runCli(['verify', '--db', dir]);
  assert.equal(v.status, 0, v.stderr);
});

test('secondary index: lookup by submitter and by time range', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  store.commit([rec('e1', 'alice', 1000, 'a'), rec('e2', 'bob', 2000, 'b')]);
  store.commit([rec('e3', 'alice', 3000, 'c'), rec('e4', 'carol', 4000, 'd')]);

  assert.deepEqual(store.list({ submitter: 'alice' }).map((r) => r.id), ['e1', 'e3']);
  assert.deepEqual(store.list({ from: 1500, to: 3500 }).map((r) => r.id), ['e2', 'e3']);
  assert.deepEqual(store.list({ submitter: 'alice', from: 1500 }).map((r) => r.id), ['e3']);
  assert.deepEqual(store.list({ to: 1000 }).map((r) => r.id), ['e1']);

  // Index survives reopen and is consistent after recovery.
  const reopened = new EvidenceStore(dir);
  assert.deepEqual(reopened.list({ submitter: 'alice' }).map((r) => r.id), ['e1', 'e3']);

  // CLI list with filters.
  const r = runCli(['list', '--db', dir, '--submitter', 'alice', '--from', '1500']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x.id), ['e3']);
});

test('missing certificate is reported as NO_CERT', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  store.commit([rec('e1', 'alice', 1000, 'a')]);
  const c2 = store.commit([rec('e2', 'bob', 2000, 'b')]);
  store.commit([rec('e3', 'carol', 3000, 'c')]);

  // Delete the middle batch's certificate. The data tail is still covered by
  // the third certificate, so recovery keeps the records and verify must
  // report the missing certificate.
  fs.unlinkSync(path.join(dir, 'certs', c2.batchId + '.json'));

  const reopened = new EvidenceStore(dir);
  assert.throws(
    () => reopened.verify(),
    (err) => err.code === 'NO_CERT' && err.batchId === c2.batchId
  );

  const v = runCli(['verify', '--db', dir]);
  assert.equal(v.status, 3);
  assert.match(v.stderr, /NO_CERT/);

  const c = runCli(['cert', '--db', dir, '--batch', c2.batchId]);
  assert.equal(c.status, 3);
  assert.match(c.stderr, /NO_CERT/);
});

test('CLI put/get round-trip', () => {
  const dir = tmpdir();
  const p = runCli(['put', '--db', dir, '--id', 'x1', '--submitter', 'dan', '--data', 'hello',
    '--timestamp', '1234']);
  assert.equal(p.status, 0, p.stderr);
  const cert = JSON.parse(p.stdout);
  assert.equal(cert.recordIds[0], 'x1');

  const g = runCli(['get', '--db', dir, '--id', 'x1']);
  assert.equal(g.status, 0, g.stderr);
  const got = JSON.parse(g.stdout);
  assert.equal(got.payload, 'hello');
  assert.equal(got.submitter, 'dan');

  const missing = runCli(['get', '--db', dir, '--id', 'nope']);
  assert.equal(missing.status, 4);
  assert.match(missing.stderr, /NOT_FOUND/);
});
