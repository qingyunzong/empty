import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EvidenceStore, EvidenceError, ZERO_HASH, recordHash } from '../src/store.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));
}

// NOTE: this sandbox cannot capture child stdio via pipes, so redirect to files.
function runCli(args, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-'));
  const outPath = path.join(tmp, 'stdout');
  const errPath = path.join(tmp, 'stderr');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
    ...(opts.env ? { env: opts.env } : {}),
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
    error: r.error,
  };
}

test('scenario 1: three batches commit, verify passes, certs independently verifiable', async () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  const c1 = store.commit([{ id: 'a1', submitter: 'alice', data: 'report-1', timestamp: '2026-01-01T00:00:00.000Z' }]);
  const c2 = store.commit([
    { id: 'b1', submitter: 'bob', data: 'photo-1', timestamp: '2026-01-02T00:00:00.000Z' },
    { id: 'b2', submitter: 'bob', data: 'photo-2', timestamp: '2026-01-02T01:00:00.000Z' },
  ]);
  const c3 = store.commit([{ id: 'c1', submitter: 'alice', data: 'log-1', timestamp: '2026-01-03T00:00:00.000Z' }]);
  assert.equal(c1.batch, 1);
  assert.equal(c2.batch, 2);
  assert.equal(c2.recordCount, 2);
  assert.equal(c3.batch, 3);

  const res = store.verify();
  assert.equal(res.ok, true);
  assert.equal(res.records, 4);
  assert.equal(res.batches, 3);

  // Independent verification: recompute chain straight from data.log bytes.
  const crypto = await import('node:crypto');
  const buf = fs.readFileSync(path.join(dir, 'data.log'));
  let off = 0;
  let prev = ZERO_HASH;
  const heads = new Map();
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const rec = JSON.parse(buf.subarray(off + 4, off + 4 + len).toString('utf8'));
    const content = JSON.stringify({
      batch: rec.batch, data: rec.data, id: rec.id, seq: rec.seq,
      submitter: rec.submitter, timestamp: rec.timestamp,
    });
    const h = crypto.createHash('sha256')
      .update(Buffer.from(prev, 'hex'))
      .update(content, 'utf8')
      .digest('hex');
    assert.equal(rec.prevHash, prev, 'chain link');
    assert.equal(rec.hash, h, 'record hash');
    prev = h;
    heads.set(rec.batch, h);
    off += 4 + len;
  }
  // Each cert file matches the independently computed batch head.
  for (const [batch, head] of heads) {
    const cert = JSON.parse(fs.readFileSync(path.join(dir, 'certs', String(batch).padStart(6, '0') + '.cert'), 'utf8'));
    assert.equal(cert.headHash, head);
  }
  assert.equal(c3.headHash, heads.get(3));

  // get re-verifies on read.
  assert.equal(store.get('b2').data, 'photo-2');
  assert.throws(() => store.get('nope'), (e) => e.code === 'NOT_FOUND');
});

test('scenario 2: one-byte tamper of data.log -> TAMPER with correct offset', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  store.commit([{ id: 'x1', submitter: 'alice', data: 'AAAA', timestamp: '2026-01-01T00:00:00.000Z' }]);
  store.commit([{ id: 'x2', submitter: 'bob', data: 'BBBB', timestamp: '2026-01-02T00:00:00.000Z' }]);
  store.commit([{ id: 'x3', submitter: 'carol', data: 'CCCC', timestamp: '2026-01-03T00:00:00.000Z' }]);
  assert.equal(store.verify().ok, true);

  // Locate record x2's frame offset and flip one byte inside its payload.
  const dataFile = path.join(dir, 'data.log');
  const buf = fs.readFileSync(dataFile);
  const firstLen = buf.readUInt32BE(0);
  const rec2Offset = 4 + firstLen;
  const needle = buf.indexOf('BBBB', rec2Offset);
  assert.ok(needle > rec2Offset);
  buf[needle] = 'X'.charCodeAt(0);
  fs.writeFileSync(dataFile, buf);

  // Fresh store instance: verify must report TAMPER at exactly rec2Offset.
  const store2 = new EvidenceStore(dir);
  assert.throws(() => store2.verify(), (e) => {
    assert.equal(e.code, 'TAMPER');
    assert.equal(e.offset, rec2Offset);
    return true;
  });
  // get on the tampered record also fails fast.
  assert.throws(() => store2.get('x2'), (e) => e.code === 'TAMPER' && e.offset === rec2Offset);
  // Untampered records still readable.
  assert.equal(store2.get('x1').data, 'AAAA');

  // CLI reports TAMPER on stderr with the offset.
  const r = runCli(['verify', '--dir', dir]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TAMPER/);
  assert.match(r.stderr, new RegExp(`offset=${rec2Offset}`));
});

test('scenario 3: crash before cert write -> batch invisible, prior certs valid', () => {
  const dir = tmpdir();
  // Two healthy commits first.
  assert.equal(runCli(['put', '--dir', dir, '--id', 'ok1', '--submitter', 'alice', '--data', 'good-1']).status, 0);
  assert.equal(runCli(['put', '--dir', dir, '--id', 'ok2', '--submitter', 'alice', '--data', 'good-2']).status, 0);
  const certBefore = fs.readFileSync(path.join(dir, 'certs', '000002.cert'), 'utf8');

  // Crash (real process exit) after data.log write, before cert write.
  const crashed = runCli(
    ['put', '--dir', dir, '--id', 'ghost', '--submitter', 'mallory', '--data', 'doomed'],
    { env: { ...process.env, EVIDENCE_CRASH_BEFORE_CERT: '1' } },
  );
  assert.equal(crashed.status, 2);

  // Reopen: recovery rolls the batch back.
  const store = new EvidenceStore(dir);
  assert.throws(() => store.get('ghost'), (e) => e.code === 'NOT_FOUND');
  assert.equal(store.list().length, 2);
  const res = store.verify();
  assert.equal(res.ok, true);
  assert.equal(res.records, 2);
  assert.equal(res.batches, 2);
  // WAL cleared by recovery.
  assert.equal(fs.statSync(path.join(dir, 'wal.log')).size, 0);
  // Prior certificates untouched and still valid.
  assert.equal(fs.readFileSync(path.join(dir, 'certs', '000002.cert'), 'utf8'), certBefore);
  assert.throws(() => store.cert(3), (e) => e.code === 'NO_CERT');

  // New commits continue cleanly after recovery.
  const c = store.commit([{ id: 'after', submitter: 'alice', data: 'post-crash' }]);
  assert.equal(c.batch, 3);
  assert.equal(store.verify().ok, true);
});

test('secondary index: query by submitter and time range', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  store.commit([{ id: 'i1', submitter: 'alice', data: 'd1', timestamp: '2026-01-01T00:00:00.000Z' }]);
  store.commit([{ id: 'i2', submitter: 'bob', data: 'd2', timestamp: '2026-01-05T00:00:00.000Z' }]);
  store.commit([{ id: 'i3', submitter: 'alice', data: 'd3', timestamp: '2026-01-10T00:00:00.000Z' }]);

  assert.deepEqual(store.list({ submitter: 'alice' }).map((r) => r.id), ['i1', 'i3']);
  assert.deepEqual(
    store.list({ from: '2026-01-02T00:00:00.000Z', to: '2026-01-06T00:00:00.000Z' }).map((r) => r.id),
    ['i2'],
  );
  assert.deepEqual(
    store.list({ submitter: 'alice', from: '2026-01-02T00:00:00.000Z' }).map((r) => r.id),
    ['i3'],
  );

  // Index tampering is detected by verify.
  const idxPath = path.join(dir, 'index.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.bySubmitter.alice = ['i1'];
  fs.writeFileSync(idxPath, JSON.stringify(idx));
  assert.throws(() => new EvidenceStore(dir).verify(), (e) => e.code === 'TAMPER');
});

test('NO_CERT: deleting a certificate is reported', () => {
  const dir = tmpdir();
  const store = new EvidenceStore(dir);
  store.commit([{ id: 'n1', submitter: 'alice', data: 'x' }]);
  fs.unlinkSync(path.join(dir, 'certs', '000001.cert'));
  assert.throws(() => new EvidenceStore(dir).verify(), (e) => e.code === 'NO_CERT' && e.batch === 1);
  const r = runCli(['cert', '--dir', dir, '--batch', '1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NO_CERT/);
});

test('CLI end-to-end: put/get/list/verify/cert', () => {
  const dir = tmpdir();
  const batchFile = path.join(dir, 'batch.json');
  fs.writeFileSync(batchFile, JSON.stringify([
    { id: 'm1', submitter: 'alice', data: 'one', timestamp: '2026-02-01T00:00:00.000Z' },
    { id: 'm2', submitter: 'alice', data: 'two', timestamp: '2026-02-02T00:00:00.000Z' },
  ]));
  const put = runCli(['put', '--dir', dir, '--batch-file', batchFile]);
  assert.equal(put.status, 0, put.stderr);
  assert.match(put.stdout, /"committed":1/);

  const get = runCli(['get', '--dir', dir, '--id', 'm2']);
  assert.equal(get.status, 0);
  assert.match(get.stdout, /"data": "two"/);

  const list = runCli(['list', '--dir', dir, '--submitter', 'alice', '--from', '2026-02-02T00:00:00.000Z']);
  assert.equal(list.status, 0);
  assert.deepEqual(JSON.parse(list.stdout).map((r) => r.id), ['m2']);

  const verify = runCli(['verify', '--dir', dir]);
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /"ok":true/);

  const certOut = path.join(dir, 'exported.cert');
  const cert = runCli(['cert', '--dir', dir, '--batch', '1', '--out', certOut]);
  assert.equal(cert.status, 0);
  const exported = JSON.parse(fs.readFileSync(certOut, 'utf8'));
  assert.equal(exported.batch, 1);
  assert.equal(exported.recordCount, 2);
});
