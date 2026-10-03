import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashValue } from '../src/canonical.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;

function setup(base, left, right) {
  const dir = mkdtempSync(join(tmpdir(), 'tri-merge-'));
  const out = join(dir, 'out');
  const paths = {
    base: join(dir, 'base.json'),
    left: join(dir, 'left.json'),
    right: join(dir, 'right.json'),
  };
  writeFileSync(paths.base, JSON.stringify(base));
  writeFileSync(paths.left, JSON.stringify(left));
  writeFileSync(paths.right, JSON.stringify(right));
  return { dir, out, paths };
}

// Spawn the CLI as a real process. stdout/stderr are redirected to files
// (pipes are unavailable in some sandboxes); the real exit code is returned.
function runCli(argv) {
  const dir = mkdtempSync(join(tmpdir(), 'tri-merge-io-'));
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  try {
    const res = spawnSync(process.execPath, [CLI, ...argv], {
      stdio: ['ignore', outFd, errFd],
    });
    assert.ok(!res.error, `spawn failed: ${res.error && res.error.message}`);
    return {
      status: res.status,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

test('clean merge: exit 0, merged.json + certificate.json, hash matches', () => {
  const { out, paths } = setup(
    { obs1: { value: 1, unit: 'm' } },
    { obs1: { value: 2, unit: 'm' } },
    { obs1: { value: 1, unit: 'cm' } },
  );
  const res = runCli(['merge', paths.base, paths.left, paths.right, '--out', out]);
  assert.equal(res.status, 0, res.stderr);

  const merged = JSON.parse(readFileSync(join(out, 'merged.json'), 'utf8'));
  assert.deepEqual(merged, { obs1: { value: 2, unit: 'cm' } });

  const cert = JSON.parse(readFileSync(join(out, 'certificate.json'), 'utf8'));
  assert.equal(cert.algorithm, 'sha256');
  assert.equal(cert.merged.sha256, hashValue(merged));
  assert.equal(cert.merged.records, 1);
  assert.equal(cert.stats.conflicts, 0);
  assert.ok(!existsSync(join(out, 'conflicts.json')));
});

test('conflicting merge: exit 2, only conflicts.json, no partial merge', () => {
  const { out, paths } = setup(
    { obs1: { value: 1 } },
    { obs1: { value: 2 } },
    { obs1: { value: 3 } },
  );
  const res = runCli(['merge', paths.base, paths.left, paths.right, '--out', out]);
  assert.equal(res.status, 2, res.stderr);

  const conflicts = JSON.parse(readFileSync(join(out, 'conflicts.json'), 'utf8'));
  assert.equal(conflicts.status, 'conflict');
  assert.equal(conflicts.conflicts.length, 1);
  assert.equal(conflicts.conflicts[0].type, 'both-modified');

  assert.ok(!existsSync(join(out, 'merged.json')), 'must not emit merged.json');
  assert.ok(!existsSync(join(out, 'certificate.json')), 'must not emit certificate.json');
});

test('usage and I/O errors exit 1', () => {
  const noArgs = runCli([]);
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /Usage: merge/);

  const missing = runCli([
    'merge',
    '/nonexistent/a.json',
    '/nonexistent/b.json',
    '/nonexistent/c.json',
    '--out',
    '/tmp/tri-merge-nowhere',
  ]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read/);

  const dir = mkdtempSync(join(tmpdir(), 'tri-merge-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  const invalid = runCli(['merge', bad, bad, bad, '--out', join(dir, 'out')]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /invalid JSON/);
});

test('certificate is reproducible across runs', () => {
  const a = setup({ o: { value: 1 } }, { o: { value: 2 } }, { o: { value: 1 } });
  const b = setup({ o: { value: 1 } }, { o: { value: 2 } }, { o: { value: 1 } });
  assert.equal(runCli(['merge', a.paths.base, a.paths.left, a.paths.right, '--out', a.out]).status, 0);
  assert.equal(runCli(['merge', b.paths.base, b.paths.left, b.paths.right, '--out', b.out]).status, 0);
  const certA = readFileSync(join(a.out, 'certificate.json'), 'utf8');
  const certB = readFileSync(join(b.out, 'certificate.json'), 'utf8');
  assert.equal(certA, certB);
});
