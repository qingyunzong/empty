import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { INDEX_FILE, TOMBSTONE_FILE } from '../src/index.js';

const DOCS = [
  { id: 'c1', merchant: 'Acme', amount: 5.5, tags: ['x'], text: 'one two three one two', status: 'settled' },
  { id: 'c2', merchant: 'Beta', amount: 7, tags: [], text: 'one two three', status: 'settled' },
];

// Drives the CLI exactly as bin/cli.js does, capturing exit code and output.
// (The sandbox blocks grandchild processes, so process-level spawning is
// verified manually; bin/cli.js is a thin process.exit(runCli(...)) wrapper.)
function run(args) {
  let stdout = '';
  let stderr = '';
  const status = runCli(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { status, stdout, stderr };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-cli-'));
  const file = path.join(dir, 'data.jsonl');
  fs.writeFileSync(file, DOCS.map((d) => JSON.stringify(d)).join('\n') + '\n');
  const indexDir = path.join(dir, 'idx');
  const res = run(['build', '--dir', indexDir, '--file', file]);
  assert.equal(res.status, 0, res.stderr);
  return { dir, file, indexDir };
}

test('CLI build/query/revoke/restore happy path', () => {
  const { indexDir } = setup();
  const q = run(['query', '--dir', indexDir, '--phrase', 'one two', '--slop', '0']);
  assert.equal(q.status, 0, q.stderr);
  const out = JSON.parse(q.stdout);
  assert.deepEqual(out.matches.map((m) => m.id).sort(), ['c1', 'c2']);
  assert.equal(out.certificate.indexVersion, 1);

  assert.equal(run(['revoke', '--dir', indexDir, '--id', 'c1']).status, 0);
  const q2 = JSON.parse(run(['query', '--dir', indexDir, '--phrase', 'one two']).stdout);
  assert.deepEqual(q2.matches.map((m) => m.id), ['c2']);

  assert.equal(run(['restore', '--dir', indexDir, '--id', 'c1']).status, 0);
  const q3 = JSON.parse(run(['query', '--dir', indexDir, '--phrase', 'one two']).stdout);
  assert.deepEqual(q3.matches.map((m) => m.id).sort(), ['c1', 'c2']);
});

test('unknown id exits 1 with {"error","code"} and leaves state untouched', () => {
  const { indexDir } = setup();
  const indexBefore = fs.readFileSync(path.join(indexDir, INDEX_FILE), 'utf8');
  const tombBefore = fs.readFileSync(path.join(indexDir, TOMBSTONE_FILE), 'utf8');
  for (const cmd of ['revoke', 'restore']) {
    const res = run([cmd, '--dir', indexDir, '--id', 'ghost']);
    assert.equal(res.status, 1, `${cmd} should exit 1`);
    assert.equal(res.stdout, '');
    const err = JSON.parse(res.stderr);
    assert.equal(err.code, 'UNKNOWN_ID');
    assert.equal(typeof err.error, 'string');
  }
  assert.equal(fs.readFileSync(path.join(indexDir, INDEX_FILE), 'utf8'), indexBefore);
  assert.equal(fs.readFileSync(path.join(indexDir, TOMBSTONE_FILE), 'utf8'), tombBefore);
});

test('illegal slop exits 1 with INVALID_SLOP and leaves state untouched', () => {
  const { indexDir } = setup();
  const indexBefore = fs.readFileSync(path.join(indexDir, INDEX_FILE), 'utf8');
  for (const slop of ['-1', 'abc', '1.5', '']) {
    const res = run(['query', '--dir', indexDir, '--phrase', 'one two', '--slop', slop]);
    assert.equal(res.status, 1, `slop=${JSON.stringify(slop)} should exit 1`);
    assert.equal(JSON.parse(res.stderr).code, 'INVALID_SLOP');
  }
  assert.equal(fs.readFileSync(path.join(indexDir, INDEX_FILE), 'utf8'), indexBefore);
});

test('corrupt JSONL exits 1 with CORRUPT_JSON and leaves prior index untouched', () => {
  const { dir, indexDir } = setup();
  const indexBefore = fs.readFileSync(path.join(indexDir, INDEX_FILE), 'utf8');

  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, JSON.stringify(DOCS[0]) + '\n{"id":"broken",\n');
  const res = run(['add', '--dir', indexDir, '--file', bad]);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).code, 'CORRUPT_JSON');
  assert.equal(fs.readFileSync(path.join(indexDir, INDEX_FILE), 'utf8'), indexBefore);

  // build into a fresh dir with corrupt input also fails cleanly
  const freshDir = path.join(dir, 'fresh');
  const res2 = run(['build', '--dir', freshDir, '--file', bad]);
  assert.equal(res2.status, 1);
  assert.equal(JSON.parse(res2.stderr).code, 'CORRUPT_JSON');
  assert.equal(fs.existsSync(path.join(freshDir, INDEX_FILE)), false);
});

test('corrupt index file on disk exits 1 with CORRUPT_JSON', () => {
  const { indexDir } = setup();
  fs.writeFileSync(path.join(indexDir, INDEX_FILE), '{not json');
  const res = run(['query', '--dir', indexDir, '--phrase', 'one two']);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).code, 'CORRUPT_JSON');
});
