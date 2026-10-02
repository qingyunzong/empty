import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdirPath, runCli } from '../testlib/helpers.js';

// End-to-end: append on three sites, merge out of order, verify, export.
test('append/merge/verify/export round trip via CLI', () => {
  const dir = tmpdirPath();
  const logs = { A: join(dir, 'a.jsonl'), B: join(dir, 'b.jsonl'), C: join(dir, 'c.jsonl') };

  for (const [site, file] of Object.entries(logs)) {
    for (let i = 1; i <= 3; i++) {
      const res = runCli(['append', '--log', file, '--site', site, '--epoch', '1',
        '--type', 'step', '--payload', JSON.stringify({ step: i })]);
      assert.equal(res.status, 0, res.stderr);
      const rec = JSON.parse(res.stdout);
      assert.equal(rec.site, site);
      assert.equal(rec.seq, i);
    }
  }
  const dev = runCli(['append', '--log', logs.B, '--site', 'B', '--epoch', '2',
    '--type', 'deviation', '--payload', '{"dev":"fill-weight"}']);
  assert.equal(dev.status, 0, dev.stderr);

  const merged = join(dir, 'merged.jsonl');
  // Deliberately out-of-order file arguments.
  const m = runCli(['merge', '--out', merged, logs.C, logs.A, logs.B]);
  assert.equal(m.status, 0, m.stderr);
  assert.deepEqual(JSON.parse(m.stdout), { merged: 10, out: merged });

  const v = runCli(['verify', merged]);
  assert.equal(v.status, 0, v.stderr);
  const cert = JSON.parse(v.stdout);
  assert.equal(cert.status, 'ok');
  assert.equal(cert.count, 10);
  assert.deepEqual(cert.missing, []);
  assert.deepEqual(cert.shadowed, []);
  assert.match(cert.head, /^[0-9a-f]{64}$/);

  // Merge is replayable: merging the merged file again keeps the head.
  const merged2 = join(dir, 'merged2.jsonl');
  assert.equal(runCli(['merge', '--out', merged2, merged]).status, 0);
  const cert2 = JSON.parse(runCli(['verify', merged2]).stdout);
  assert.equal(cert2.head, cert.head);

  const certFile = join(dir, 'certificate.json');
  const x = runCli(['export', '--out', certFile, merged]);
  assert.equal(x.status, 0, x.stderr);
  const exported = JSON.parse(readFileSync(certFile, 'utf8'));
  assert.equal(exported.head, cert.head);
  assert.equal(exported.status, 'ok');
});

test('usage errors exit 2; unknown command rejected', () => {
  assert.equal(runCli(['append', '--site', 'A']).status, 2);
  assert.equal(runCli(['frobnicate']).status, 2);
  assert.equal(runCli(['verify']).status, 2);
});
