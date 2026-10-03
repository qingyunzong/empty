import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ebr.js');

// NOTE: this sandbox swallows grandchild stdout pipes, so capture via file fds.
function run(dir, name, args) {
  const outPath = join(dir, `${name}.out`);
  const errPath = join(dir, `${name}.err`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', outFd, errFd] });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

test('CLI: append/merge/verify/export round trip over JSONL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebr-'));
  const a = join(dir, 'a.jsonl');
  const b = join(dir, 'b.jsonl');
  const merged = join(dir, 'merged.jsonl');
  const cert = join(dir, 'cert.json');

  let n = 0;
  for (const [file, site] of [[a, 'S1'], [b, 'S2']]) {
    for (let i = 0; i < 3; i += 1) {
      const res = run(dir, `append-${n}`, ['append', file, '--site', site, '--gen', '1', '--type', 'step', '--payload', `{"op":"op${i}"}`]);
      n += 1;
      assert.equal(res.status, 0, res.stderr);
      const record = JSON.parse(res.stdout);
      assert.equal(typeof record.hash, 'string');
      assert.equal(record.vc[site], i + 1);
    }
  }

  const mergeRes = run(dir, 'merge', ['merge', merged, a, b]);
  assert.equal(mergeRes.status, 0, mergeRes.stderr);
  assert.deepEqual(JSON.parse(mergeRes.stdout), { merged: 6, out: merged });

  const verifyRes = run(dir, 'verify', ['verify', merged]);
  assert.equal(verifyRes.status, 0, verifyRes.stderr);
  const certificate = JSON.parse(verifyRes.stdout);
  assert.equal(certificate.status, 'ok');
  assert.equal(certificate.records, 6);
  assert.deepEqual(certificate.missing, []);

  const exportRes = run(dir, 'export', ['export', merged, '--out', cert]);
  assert.equal(exportRes.status, 0, exportRes.stderr);
  assert.ok(existsSync(cert));
  const doc = JSON.parse(readFileSync(cert, 'utf8'));
  assert.equal(doc.certificate.head, certificate.head);
  assert.equal(doc.effective.length, 6);
});

test('CLI: verify exits 15 on broken chain and 16 on low-gen backfill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ebr-'));
  const log = join(dir, 'log.jsonl');

  assert.equal(run(dir, 'a1', ['append', log, '--site', 'S1', '--gen', '1', '--type', 'step']).status, 0);
  assert.equal(run(dir, 'a2', ['append', log, '--site', 'S1', '--gen', '1', '--type', 'step']).status, 0);
  assert.equal(run(dir, 'a3', ['append', log, '--site', 'S1', '--gen', '2', '--type', 'exit']).status, 0);

  // low-gen backfill after exit
  assert.equal(run(dir, 'a4', ['append', log, '--site', 'S1', '--gen', '1', '--type', 'step']).status, 0);
  const rejected = run(dir, 'v1', ['verify', log]);
  assert.equal(rejected.status, 16, rejected.stdout + rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).status, 'rejected');

  // tamper with the file: flip a payload -> broken chain
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.payload = { op: 'forged' };
  const broken = join(dir, 'broken.jsonl');
  writeFileSync(broken, JSON.stringify(first) + '\n' + lines.slice(1).join('\n') + '\n');
  const brokenRes = run(dir, 'v2', ['verify', broken]);
  assert.equal(brokenRes.status, 15, brokenRes.stdout + brokenRes.stderr);
  assert.equal(JSON.parse(brokenRes.stdout).status, 'broken');
});
