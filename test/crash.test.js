import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archive } from '../src/archive.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-crash-'));
}

function seed(dir) {
  const archive = new Archive(dir);
  archive.ingest([{ site: 'S1', validTime: '2026-06-01T00:00:00Z', value: 10, quality: 'good' }]);
  archive.correct({
    batchId: 'OK1',
    corrections: [{ op: 'replace', site: 'S1', validTime: '2026-06-01T00:00:00Z', value: 11, quality: 'good' }],
  });
  return archive;
}

const badBatch = {
  batchId: 'BAD',
  corrections: [{ op: 'replace', site: 'S1', validTime: '2026-06-01T00:00:00Z', value: 99, quality: 'good' }],
};

test('crash at preFsync (after append+index, before fsync): unflushed batch is lost', () => {
  const dir = tmpdir();
  seed(dir);
  const crashing = new Archive(dir, { crashAt: 'preFsync' });
  assert.throws(() => crashing.correct(badBatch), /simulated crash at preFsync/);

  // recover: appended bytes never left OS buffers -> BAD is gone entirely
  const recovered = new Archive(dir);
  assert.equal(recovered.batches.has('BAD'), false);
  const audit = recovered.audit('S1|2026-06-01T00:00:00Z');
  assert.equal(audit.tip.value, 11);
  assert.equal(audit.chain.length, 2);
  // log file physically back at the last durable boundary
  const lines = fs.readFileSync(path.join(dir, 'events.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3); // obs + batch_open + obs
  // archive still usable after recovery
  recovered.correct({ batchId: 'AFTER', corrections: [{ op: 'replace', site: 'S1', validTime: '2026-06-01T00:00:00Z', value: 12, quality: 'good' }] });
  assert.equal(new Archive(dir).audit('S1|2026-06-01T00:00:00Z').tip.value, 12);
});

test('crash at postIndex (after fsync, before manifest): durable events recovered from log', () => {
  const dir = tmpdir();
  seed(dir);
  const crashing = new Archive(dir, { crashAt: 'postIndex' });
  assert.throws(() => crashing.correct(badBatch), /simulated crash at postIndex/);

  // recover: log was fsynced, manifest stale -> replay keeps BAD
  const recovered = new Archive(dir);
  assert.equal(recovered.batches.has('BAD'), true);
  assert.equal(recovered.batches.get('BAD').undone, false);
  const audit = recovered.audit('S1|2026-06-01T00:00:00Z');
  assert.equal(audit.tip.value, 99);
  // recovery refreshed the stale manifest to the replayed tip
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.committedLamport, recovered.maxLamport);
});

test('crash at postManifest (fully committed): state intact, undo survives, certificate verifies', () => {
  const dir = tmpdir();
  seed(dir);
  const crashing = new Archive(dir);
  crashing.correct(badBatch);
  crashing.crashAt = 'postManifest';
  assert.throws(() => crashing.undo('BAD'), /simulated crash at postManifest/);

  const recovered = new Archive(dir);
  assert.equal(recovered.batches.get('BAD').undone, true);
  const audit = recovered.audit('S1|2026-06-01T00:00:00Z');
  assert.equal(audit.tip.value, 11); // BAD's 99 rolled back
  const cert = recovered.certificate('BAD');
  assert.equal(cert.undone, true);
  const result = Archive.verifyCertificate(cert, recovered);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('certificate verifies after crash+recovery at every fault point', () => {
  for (const point of ['preFsync', 'postIndex', 'postManifest']) {
    const dir = tmpdir();
    seed(dir);
    const crashing = new Archive(dir, { crashAt: point });
    try {
      crashing.correct(badBatch);
      crashing.undo('BAD');
    } catch (err) {
      assert.match(err.message, /simulated crash/);
    }
    const recovered = new Archive(dir);
    // whatever survived, the archive must be consistent: indexed == brute
    const qi = recovered.query('S1', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
    const qb = recovered.query('S1', '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z', { brute: true });
    assert.equal(qi.weightedMean, qb.weightedMean, `point ${point}`);
    // certificates for surviving batches verify
    for (const [batchId] of recovered.batches) {
      const cert = recovered.certificate(batchId);
      const result = Archive.verifyCertificate(cert, recovered);
      assert.equal(result.ok, true, `point ${point} batch ${batchId}: ${result.errors}`);
    }
  }
});
