import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-cli-'));
}

function run(dir, args, env = {}) {
  let buf = '';
  runCli(args, { WXA_DATA: dir, ...env }, (s) => { buf += s; });
  return JSON.parse(buf);
}

test('CLI end-to-end: ingest, correct, query, audit, undo, certificate, verify', () => {
  const dir = tmpdir();
  const obsPath = path.join(dir, 'obs.jsonl');
  fs.writeFileSync(obsPath, [
    JSON.stringify({ site: 'S1', validTime: '2026-07-01T00:00:00Z', value: 10, quality: 'good' }),
    JSON.stringify({ site: 'S1', validTime: '2026-07-01T06:00:00Z', value: 20, quality: 'unknown' }),
    JSON.stringify({ site: 'S1', validTime: '2026-07-01T12:00:00Z', value: null, quality: 'good' }),
  ].join('\n') + '\n');

  const ing = run(dir, ['ingest', obsPath]);
  assert.equal(ing.ok, true);
  assert.equal(ing.ingested, 3);

  const batchPath = path.join(dir, 'batch.json');
  fs.writeFileSync(batchPath, JSON.stringify({
    batchId: 'CLI1',
    corrections: [{ op: 'replace', site: 'S1', validTime: '2026-07-01T00:00:00Z', value: 12, quality: 'good' }],
  }));
  const cor = run(dir, ['correct', batchPath]);
  assert.equal(cor.ok, true);

  const q = run(dir, ['query', 'S1', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z']);
  assert.equal(q.weightedMean, (12 * 1.0 + 20 * 0.25) / 1.25);
  assert.equal(q.nullCount, 1);
  assert.equal(q.trust, 'unknown');

  const qb = run(dir, ['query', 'S1', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z'], { WXA_BRUTE: '1' });
  assert.equal(qb.weightedMean, q.weightedMean);

  const audit = run(dir, ['audit', 'S1|2026-07-01T00:00:00Z']);
  assert.equal(audit.tip.value, 12);
  assert.equal(audit.chain.length, 2);

  const cert = run(dir, ['certificate', 'CLI1']);
  const certPath = path.join(dir, 'cert.json');
  fs.writeFileSync(certPath, JSON.stringify(cert));

  const und = run(dir, ['undo', 'CLI1']);
  assert.equal(und.ok, true);

  const q2 = run(dir, ['query', 'S1', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z']);
  assert.equal(q2.weightedMean, (10 * 1.0 + 20 * 0.25) / 1.25);

  // certificate captured before undo no longer matches live state
  const stale = run(dir, ['verify', certPath]);
  assert.equal(stale.ok, false);

  // fresh certificate after undo verifies
  const cert2 = run(dir, ['certificate', 'CLI1']);
  assert.equal(cert2.undone, true);
  const cert2Path = path.join(dir, 'cert2.json');
  fs.writeFileSync(cert2Path, JSON.stringify(cert2));
  const fresh = run(dir, ['verify', cert2Path]);
  assert.equal(fresh.ok, true);
});

test('CLI crash injection via WXA_CRASH_AT', () => {
  const dir = tmpdir();
  const obsPath = path.join(dir, 'obs.jsonl');
  fs.writeFileSync(obsPath, JSON.stringify({ site: 'S1', validTime: '2026-07-01T00:00:00Z', value: 10, quality: 'good' }) + '\n');
  run(dir, ['ingest', obsPath]);

  const batchPath = path.join(dir, 'batch.json');
  fs.writeFileSync(batchPath, JSON.stringify({
    batchId: 'CR1',
    corrections: [{ op: 'replace', site: 'S1', validTime: '2026-07-01T00:00:00Z', value: 99, quality: 'good' }],
  }));
  assert.throws(() => run(dir, ['correct', batchPath], { WXA_CRASH_AT: 'preFsync' }));

  // recovery: batch lost
  const audit = run(dir, ['audit', 'S1|2026-07-01T00:00:00Z']);
  assert.equal(audit.tip.value, 10);
});
