import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

test('cli: commit / get --at / audit --party / verify / tamper-test', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-audit-cli-'));

  const c1 = await runCli(['commit', '--dir', dir, '--type', 'payment', '--id', 't1', '--party', 'alice', '--amount', '100', '--currency', 'USD']);
  assert.equal(c1.code, 0);
  assert.equal(c1.output.ok, true);
  assert.equal(c1.output.certificate.version, 1);
  assert.match(c1.output.certificate.digest, /^[0-9a-f]{64}$/);

  await runCli(['commit', '--dir', dir, '--type', 'settlement', '--id', 't2', '--party', 'alice', '--amount', '-30', '--currency', 'USD']);
  await runCli(['commit', '--dir', dir, '--type', 'reversal', '--ref', 't1']);

  const v = await runCli(['verify', '--dir', dir]);
  assert.equal(v.code, 0);
  assert.equal(v.output.ok, true);
  assert.equal(v.output.versions, 3);

  const g1 = await runCli(['get', '--dir', dir, '--id', 't1', '--at', '1']);
  assert.equal(g1.output.record.status, 'active');
  const g3 = await runCli(['get', '--dir', dir, '--id', 't1', '--at', '3']);
  assert.equal(g3.output.record.status, 'reversed');

  const audit = await runCli(['audit', '--dir', dir, '--party', 'alice', '--at', '2']);
  assert.deepEqual(audit.output.records.map((r) => r.id), ['t1', 't2']);

  // Optimistic concurrency via CLI: stale expected version is rejected.
  const conflict = await runCli(['commit', '--dir', dir, '--type', 'payment', '--id', 't4', '--party', 'bob', '--amount', '1', '--currency', 'USD', '--expected-version', '1']);
  assert.equal(conflict.code, 1);
  assert.equal(conflict.output.code, 'E_CONFLICT');

  const tt = await runCli(['tamper-test', '--dir', dir, '--seq', '2']);
  assert.equal(tt.code, 0);
  assert.equal(tt.output.ok, true);
  assert.equal(tt.output.tamperedSeq, 2);
  assert.equal(tt.output.verify.code, 'E_TAMPER');
  assert.equal(tt.output.verify.seq, 2);

  // Original dir untouched.
  const v2 = await runCli(['verify', '--dir', dir]);
  assert.equal(v2.output.ok, true);
});
