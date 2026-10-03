'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EventLog, LogError, FOOTER_LEN } = require('../src/eventlog');
const codec = require('../src/codec');
const cli = require('../cli.js');

function tmpFile(name = 'log.bin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devlog-'));
  return path.join(dir, name);
}

// Independent line-by-line fold used to cross-check the library view.
function manualFold(records) {
  const baseline = new Map();
  const out = new Map();
  const dead = new Set();
  for (const r of records) {
    if (r.type === 'event') {
      const e = {
        seq: r.seq,
        ts: r.ts,
        device: r.device,
        status: r.status,
        payload: r.payload,
        corrections: [],
      };
      baseline.set(r.seq, e);
      out.set(r.seq, e);
    } else if (r.type === 'correction') {
      assert.ok(baseline.has(r.refSeq), `correction ${r.seq} has dangling ref ${r.refSeq}`);
      const cur = out.get(r.refSeq);
      if (cur && !dead.has(r.refSeq)) {
        cur.status = r.status;
        cur.payload = r.payload;
        cur.corrections.push(r.seq);
      }
    } else if (r.type === 'tombstone') {
      assert.ok(baseline.has(r.refSeq), `tombstone ${r.seq} has dangling ref ${r.refSeq}`);
      dead.add(r.refSeq);
      out.delete(r.refSeq);
    }
  }
  return [...out.values()].sort((a, b) => a.seq - b.seq);
}

test('appends round-trip and view matches manual line-by-line fold', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  const inputs = [];
  for (let i = 0; i < 10; i++) {
    const input = {
      device: `sensor-${i % 3}`,
      status: (i * 7) % 5,
      payload: `reading-${i}`,
      ts: 1_700_000_000_000 + i * 1000,
    };
    inputs.push(input);
    assert.equal(log.append(input), i + 1);
  }
  log.close();

  const reopened = EventLog.open(file);
  const audit = reopened.audit();
  assert.equal(audit.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(audit[i].seq, i + 1);
    assert.equal(audit[i].device, inputs[i].device);
    assert.equal(audit[i].status, inputs[i].status);
    assert.equal(audit[i].payload.toString('utf8'), inputs[i].payload);
    assert.equal(audit[i].ts, inputs[i].ts);
    assert.match(audit[i].hash, /^[0-9a-f]{64}$/);
  }

  const view = reopened.view();
  assert.deepEqual(view, manualFold(audit));
  assert.equal(view.length, 10);
});

test('records in one block are delta-encoded and decode correctly', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  for (let i = 0; i < 6; i++) {
    log.append({ device: 'dev', status: 100 + i, payload: `p${i}`, ts: 5000 + i * 250 });
  }
  log.close();

  // Exactly one block in the file.
  const buf = fs.readFileSync(file);
  const { records, nextOffset } = codec.decodeBlock(buf, 8);
  assert.equal(records.length, 6);
  assert.equal(buf.readUInt32LE(nextOffset), codec.INDEX_MAGIC);

  // Delta encoding: 6 naive JSON records would be far larger than the block.
  const naiveSize = 6 * JSON.stringify({ device: 'dev', status: 100, payload: 'p0', ts: 5000 }).length;
  assert.ok(nextOffset < naiveSize, `block ${nextOffset} bytes should beat naive ${naiveSize}`);

  const view = EventLog.open(file).view();
  assert.deepEqual(
    view.map((e) => [e.seq, e.ts, e.status]),
    [0, 1, 2, 3, 4, 5].map((i) => [i + 1, 5000 + i * 250, 100 + i]),
  );
});

test('out-of-order corrections change the view and certificates stay verifiable', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  log.append({ device: 'a', status: 1, payload: 'a0', ts: 100 });
  log.append({ device: 'b', status: 2, payload: 'b0', ts: 200 });
  log.append({ device: 'c', status: 3, payload: 'c0', ts: 300 });
  log.flush();
  const before = log.view();

  // Corrections arrive out of order relative to the events they fix.
  const c2 = log.correct(2, { reason: 'wrong status', status: 22, payload: 'b1', ts: 400 });
  const c1 = log.correct(1, { reason: 'late fix', status: 11, payload: 'a1', ts: 500 });
  log.close();

  const log2 = EventLog.open(file);
  const after = log2.view();
  assert.notDeepEqual(after, before);
  assert.equal(after.find((e) => e.seq === 2).status, 22);
  assert.equal(after.find((e) => e.seq === 2).payload.toString('utf8'), 'b1');
  assert.equal(after.find((e) => e.seq === 1).status, 11);
  assert.deepEqual(after.find((e) => e.seq === 1).corrections, [c1.seq]);
  assert.deepEqual(after, manualFold(log2.audit()));

  // Certificates re-verify against the reopened log.
  assert.equal(log2.verifyCertificate(c1.certificate), true);
  assert.equal(log2.verifyCertificate(c2.certificate), true);
  assert.equal(c1.certificate.activeSeq, c1.seq);
  assert.equal(c2.certificate.refSeq, 2);

  // Tampered certificates fail.
  assert.equal(log2.verifyCertificate({ ...c1.certificate, originalHash: '00'.repeat(32) }), false);
  assert.equal(log2.verifyCertificate({ ...c1.certificate, activeSeq: 999 }), false);
});

test('tombstone removes event from view but audit keeps full history', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  log.append({ device: 'a', status: 1, payload: 'keep', ts: 1 });
  log.append({ device: 'b', status: 2, payload: 'drop', ts: 2 });
  const { seq, certificate } = log.revoke(2, { reason: 'retracted', ts: 3 });
  log.close();

  const log2 = EventLog.open(file);
  const view = log2.view();
  assert.deepEqual(view.map((e) => e.seq), [1]);

  const audit = log2.audit();
  assert.equal(audit.length, 3);
  assert.equal(audit[1].type, 'event');
  assert.equal(audit[2].type, 'tombstone');
  assert.equal(audit[2].refSeq, 2);
  assert.equal(audit[2].reason, 'retracted');
  assert.equal(audit[2].seq, seq);
  assert.equal(log2.verifyCertificate(certificate), true);
  assert.deepEqual(view, manualFold(audit));
});

test('corrupt block yields E_CRC, blocks the block, and leaves no half-updated state', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  log.append({ device: 'a', status: 1, payload: 'first', ts: 1 });
  log.append({ device: 'b', status: 2, payload: 'second', ts: 2 });
  log.flush();
  const intactView = log.view();
  log.append({ device: 'c', status: 3, payload: 'third', ts: 3 });
  log.append({ device: 'd', status: 4, payload: 'fourth', ts: 4 });
  log.close();

  // Locate the second block and flip a payload byte.
  const buf = fs.readFileSync(file);
  const { nextOffset } = codec.decodeBlock(buf, 8);
  buf[nextOffset + codec.BLOCK_HEADER_LEN + 2] ^= 0xff;
  fs.writeFileSync(file, buf);
  const corruptedBytes = fs.readFileSync(file);

  const degraded = EventLog.open(file);
  assert.throws(() => degraded.view(), (err) => err.code === 'E_CRC');
  assert.throws(() => degraded.audit(), (err) => err.code === 'E_CRC');

  // The intact prefix is still fully readable; the corrupt block contributes nothing.
  const safe = degraded.safeView();
  assert.equal(safe.error.code, 'E_CRC');
  assert.deepEqual(safe.view, intactView);

  // Writes are refused and the file is untouched: no half-updated state.
  assert.throws(() => degraded.append({ device: 'x' }), (err) => err.code === 'E_CRC');
  assert.throws(() => degraded.correct(1, { reason: 'r' }), (err) => err.code === 'E_CRC');
  assert.deepEqual(fs.readFileSync(file), corruptedBytes);
});

test('corrupt index triggers full-scan rebuild; restart gives identical results', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  for (let i = 0; i < 4; i++) log.append({ device: `d${i}`, status: i, payload: `p${i}`, ts: 10 + i });
  log.flush();
  log.correct(2, { reason: 'fix', status: 42, payload: 'p2x', ts: 99 });
  log.close();

  const expectedView = EventLog.open(file).view();
  const expectedAudit = EventLog.open(file).audit();

  // Corrupt a byte inside the tail index entries.
  const buf = fs.readFileSync(file);
  const indexOffset = Number(buf.readBigUInt64LE(buf.length - FOOTER_LEN));
  buf[indexOffset + 10] ^= 0xa5;
  fs.writeFileSync(file, buf);

  // Reopen ("restart"): index crc mismatch -> full scan rebuild.
  const rebuilt = EventLog.open(file);
  assert.deepEqual(rebuilt.view(), expectedView);
  assert.deepEqual(rebuilt.audit(), expectedAudit);
  assert.equal(rebuilt.getRecord(3).device, 'd2');

  // Rebuild is durable: a second restart reads the repaired index.
  const again = EventLog.open(file);
  assert.deepEqual(again.view(), expectedView);

  // Explicit rebuild on a healthy log is a no-op semantically.
  const info = again.rebuildIndex();
  assert.equal(info.entries, expectedAudit.length);
  assert.deepEqual(EventLog.open(file).view(), expectedView);
});

test('referencing a nonexistent event returns E_REVISION', () => {
  const file = tmpFile();
  const log = EventLog.open(file);
  log.append({ device: 'a', status: 1, ts: 1 });
  const { seq: correctionSeq } = log.correct(1, { reason: 'fix', status: 2, ts: 2 });
  log.close();

  assert.throws(() => log.correct(999, { reason: 'x' }), (err) => err.code === 'E_REVISION');
  assert.throws(() => log.revoke(999, { reason: 'x' }), (err) => err.code === 'E_REVISION');
  // A correction record is not an event and cannot be referenced.
  assert.throws(() => log.revoke(correctionSeq, { reason: 'x' }), (err) => err.code === 'E_REVISION');
  // Reason is mandatory.
  assert.throws(() => log.correct(1, {}), (err) => err instanceof LogError);
  assert.throws(() => log.revoke(1, {}), (err) => err instanceof LogError);
});

test('crc32 known vectors', () => {
  const { crc32 } = require('../src/crc32');
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('hello world')), 0x0d4a1185);
});

test('cli end-to-end: append, correct, view, verify, corrupt exit code', () => {
  const file = tmpFile();
  const run = (args) => {
    const io = {
      stdout: '',
      stderr: '',
      out(s) { this.stdout += s; },
      err(s) { this.stderr += s; },
      print(v) { this.stdout += JSON.stringify(v) + '\n'; },
    };
    const status = cli.run(args, io);
    return { status, stdout: io.stdout, stderr: io.stderr };
  };

  let r = run(['append', file, '--device', 'pump-1', '--status', '7', '--payload', 'on', '--ts', '1000']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { seq: 1 });

  r = run(['correct', file, '--ref', '1', '--reason', 'misread', '--status', '8', '--payload', 'off', '--ts', '2000']);
  assert.equal(r.status, 0, r.stderr);
  const { certificate } = JSON.parse(r.stdout);

  r = run(['view', file]);
  assert.equal(r.status, 0, r.stderr);
  const view = JSON.parse(r.stdout);
  assert.equal(view.length, 1);
  assert.equal(view[0].status, 8);
  assert.equal(view[0].payload, 'off');

  const certFile = tmpFile('cert.json');
  fs.writeFileSync(certFile, JSON.stringify(certificate));
  r = run(['verify', file, '--cert', certFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { valid: true });

  r = run(['correct', file, '--ref', '42', '--reason', 'nope']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /E_REVISION/);

  // Corrupt the only data block: view exits 3 with E_CRC, --partial still shows nothing half-applied.
  const buf = fs.readFileSync(file);
  buf[8 + codec.BLOCK_HEADER_LEN] ^= 0xff;
  fs.writeFileSync(file, buf);
  r = run(['view', file]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /E_CRC/);
  r = run(['view', file, '--partial']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { view: [], error: 'E_CRC' });
});
