import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli.js', import.meta.url).pathname;

const OPS = [
  { seq: 1, authorId: 'alice', type: 'add_study', id: 's1', weight: 2, effect: 0.4 },
  { seq: 2, authorId: 'alice', type: 'add_study', id: 's2', weight: 1, effect: 0.1 },
  { seq: 3, authorId: 'bob', type: 'add_study', id: 's3', weight: 3, effect: 0.9 },
  { seq: 4, authorId: 'alice', type: 'add_claim', id: 'h1', op: 'any', refs: ['s1', 's2'] },
  { seq: 5, authorId: 'bob', type: 'add_claim', id: 'h2', op: 'all', refs: ['s3'] },
  { seq: 6, authorId: 'carol', type: 'add_claim', id: 'h3', op: 'any', refs: ['s1', 's3'] },
  { seq: 7, authorId: 'alice', type: 'retract_study', id: 's3' },
];

// Runs the CLI with file redirection (pipes are unreliable in this sandbox).
function runCli(args, { stdinText } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'metaev-'));
  const outFile = join(dir, 'out.json');
  const cmd = [JSON.stringify('node'), JSON.stringify(CLI), ...args.map((a) => JSON.stringify(a))];
  let fullCmd = `${cmd.join(' ')} > ${JSON.stringify(outFile)}`;
  if (stdinText !== undefined) {
    const inFile = join(dir, 'in.json');
    writeFileSync(inFile, stdinText);
    fullCmd += ` < ${JSON.stringify(inFile)}`;
  }
  const res = spawnSync('bash', ['-c', fullCmd], { encoding: 'utf8' });
  let stdout = '';
  try {
    stdout = readFileSync(outFile, 'utf8');
  } catch { /* no output produced */ }
  return { status: res.status, stdout, stderr: res.stderr };
}

function writeOps(ops) {
  const dir = mkdtempSync(join(tmpdir(), 'metaev-'));
  const file = join(dir, 'ops.json');
  writeFileSync(file, JSON.stringify(ops));
  return file;
}

test('CLI replays a file and prints ranking JSON', () => {
  const { status, stdout } = runCli([writeOps(OPS)]);
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.equal(out.applied, 7);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.ranking.map((r) => r.id), ['h3', 'h1']);
  assert.deepEqual(out.excluded, [{ id: 'h2', status: 'excluded', reason: 'no_valid_studies' }]);
});

test('CLI reads operations from stdin', () => {
  const { status, stdout } = runCli([], { stdinText: JSON.stringify(OPS) });
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.ranking.map((r) => r.id), ['h3', 'h1']);
});

test('CLI --certificate emits hash, score, rank and study set', () => {
  const { status, stdout } = runCli(['--certificate', 'h1', writeOps(OPS)]);
  assert.equal(status, 0);
  const cert = JSON.parse(stdout).certificate;
  assert.equal(cert.hypothesisId, 'h1');
  assert.equal(cert.status, 'ok');
  assert.deepEqual(cert.studies, ['s1', 's2']);
  assert.ok(Math.abs(cert.score - 0.3) < 1e-12);
  assert.equal(cert.rank, 2);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
});

test('CLI --diffs reports per-operation ranking diffs', () => {
  const { status, stdout } = runCli(['--diffs', writeOps(OPS)]);
  assert.equal(status, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.diffs.length, 7);
  const retraction = out.diffs.find((d) => d.type === 'retract_study');
  assert.deepEqual(retraction.rankingDiff, [
    { id: 'h1', from: 3, to: 2 },
    { id: 'h2', from: 1, to: null },
    { id: 'h3', from: 2, to: 1 },
  ]);
});

test('CLI exits non-zero with E_SEQ_CONFLICT on duplicate (seq, authorId)', () => {
  const { status, stdout } = runCli([writeOps([
    { seq: 1, authorId: 'amy', type: 'add_study', id: 's1', weight: 1, effect: 0.1 },
    { seq: 1, authorId: 'amy', type: 'add_study', id: 's2', weight: 1, effect: 0.2 },
  ])]);
  assert.equal(status, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'E_SEQ_CONFLICT');
  assert.equal(out.applied, 0);
});

test('CLI reports E_PARSE for invalid JSON', () => {
  const { status, stdout } = runCli([], { stdinText: '{not json' });
  assert.equal(status, 1);
  assert.equal(JSON.parse(stdout).error.code, 'E_PARSE');
});

test('CLI reports E_NOT_FOUND for an unknown certificate id', () => {
  const { status, stdout } = runCli(['--certificate', 'nope', writeOps(OPS)]);
  assert.equal(status, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.errors.at(-1).code, 'E_NOT_FOUND');
});
