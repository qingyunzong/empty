import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../cli.js';

// Drives the CLI in-process (the offline sandbox forbids spawning children).
function run(args) {
  const out = [];
  const err = [];
  const status = main(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-cli-'));
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'a.txt'), '泵 气蚀 原因码C1 处理码T1\n\n备用泵 正常');
  fs.writeFileSync(path.join(docs, 'b.txt'), '泵 正常运行 无报警');
  fs.writeFileSync(path.join(docs, 'c.txt'), '原因码C2 f1 f2 f3 f4 f5 处理码T2');
  const indexDir = path.join(dir, 'idx');
  assert.equal(run(['build', indexDir]).status, 0);
  const idx = run(['index', indexDir, path.join(docs, 'a.txt'), path.join(docs, 'b.txt'), path.join(docs, 'c.txt')]);
  assert.equal(idx.status, 0, idx.stderr);
  return indexDir;
}

test('CLI end-to-end: build/index/query/phrase', () => {
  const indexDir = setup();
  const r = run(['query', indexDir, '"泵 气蚀"']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^a\thits=1\tspan=2/m);
  assert.doesNotMatch(r.stdout, /^b\t/m);
});

test('CLI proximity boundary: NEAR/4 excludes gap of 5, NEAR/5 includes it', () => {
  const indexDir = setup();
  const near4 = run(['query', indexDir, '原因码C2 NEAR/4 处理码T2']);
  assert.doesNotMatch(near4.stdout, /^c\t/m);
  const near5 = run(['query', indexDir, '原因码C2 NEAR/5 处理码T2']);
  assert.match(near5.stdout, /^c\thits=1\tspan=7/m);
});

test('CLI del tombstones docs; compact issues certificate; cert verifies', () => {
  const indexDir = setup();
  assert.equal(run(['del', indexDir, 'b']).status, 0);
  const q = run(['query', indexDir, '泵']);
  assert.doesNotMatch(q.stdout, /^b\t/m); // tombstone filters immediately

  const c1 = run(['compact', indexDir]);
  assert.equal(c1.status, 0, c1.stderr);
  const cert1 = JSON.parse(c1.stdout);
  assert.equal(cert1.deletionCount, 1);
  assert.ok(cert1.termCount > 0);
  assert.match(cert1.rootHash, /^[0-9a-f]{64}$/);

  const v = run(['cert', indexDir]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /certificate chain OK/);

  // a second delete+compact produces a changed certificate linked to the old one
  assert.equal(run(['del', indexDir, 'c']).status, 0);
  const c2 = run(['compact', indexDir]);
  const cert2 = JSON.parse(c2.stdout);
  assert.notEqual(cert2.rootHash, cert1.rootHash);
  assert.equal(cert2.deletionCount, 2);
  assert.equal(run(['cert', indexDir]).status, 0);
});

test('CLI query errors: E_TOKEN for empty term, E_SPAN for bad span', () => {
  const indexDir = setup();
  const empty = run(['query', indexDir, '""']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /^E_TOKEN:/);
  const span = run(['query', indexDir, '原因码 NEAR/-1 处理码']);
  assert.equal(span.status, 1);
  assert.match(span.stderr, /^E_SPAN:/);
});

test('CLI cert fails with E_CERT after tampering', () => {
  const indexDir = setup();
  run(['compact', indexDir]);
  const metaPath = path.join(indexDir, 'index.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.certs[0].deletionCount = 42;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 1));
  const v = run(['cert', indexDir]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /^E_CERT:/);
});
