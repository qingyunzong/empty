import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from '../src/cli.js';

function makeCli() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-cli-'));
  const io = {
    stateFile: join(dir, 'state.json'),
    readStdin: () => '',
    stdout: '',
    stderr: '',
    out(text) { this.stdout += text; },
    err(text) { this.stderr += text; },
  };
  const run = (args) => {
    io.stdout = '';
    io.stderr = '';
    const code = runCli(args, io);
    return { code, stdout: io.stdout, json: () => JSON.parse(io.stdout), stderr: io.stderr };
  };
  return { dir, run };
}

test('CLI: import, query, report, patch, revert, verify', () => {
  const { dir, run } = makeCli();
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify([
    { op: 'add', kind: 'VALID', intervals: [[0, 5], [10, 15]] },
    { op: 'add', kind: 'unknown-feed', intervals: [[50, 60]] },
  ]));

  const cert = run(['import', batch]).json();
  assert.equal(cert.id, 'cert-0001');
  assert.equal(cert.type, 'import');

  assert.equal(run(['query', '3']).json().status, 'VALID');
  assert.equal(run(['query', '55']).json().status, 'PENDING');
  assert.equal(run(['query', '7']).json().status, 'UNCOVERED');

  assert.deepEqual(run(['report', '0', '15']).json().gaps, [{ start: 5, end: 10 }]);

  const patchFile = join(dir, 'patch.json');
  writeFileSync(patchFile, JSON.stringify({ patchId: 'p1', reason: 'backfill', kind: 'VALID', add: [[5, 10]] }));
  const pcert = run(['patch', patchFile]).json();
  assert.equal(pcert.supersedes, 'cert-0001');
  assert.deepEqual(run(['report', '0', '15']).json().gaps, []);

  run(['revert', 'p1']);
  assert.deepEqual(run(['report', '0', '15']).json().gaps, [{ start: 5, end: 10 }]);

  const verdict = run(['verify']).json();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.certs, 3);
});

test('CLI: invalid interval exits 1 with E_INTERVAL', () => {
  const { dir, run } = makeCli();
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify([{ op: 'add', kind: 'VALID', intervals: [[9, 9]] }]));
  const res = run(['import', bad]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /E_INTERVAL/);
});

test('CLI: unknown command exits 2 and prints usage', () => {
  const { run } = makeCli();
  const res = run(['frobnicate']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /usage: audit-intervals/);
});
