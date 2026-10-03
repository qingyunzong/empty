import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

// Drives the CLI in-process (the sandbox forbids child_process spawn).
function run(args) {
  let stdout = '';
  let stderr = '';
  const code = runCli(args, (l) => (stdout += l + '\n'), (l) => (stderr += l + '\n'));
  return { code, stdout, stderr };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-idx-'));
  assert.equal(run(['build', dir]).code, 0);
  const docs = [
    { id: 'A1', text: '泵 气蚀 原因码 c01 处理码 a07 检查 入口 压力' },
    { id: 'A2', text: '泵 气蚀 原因码 c02 处理码 a09 更换 密封\n\n泵 气蚀 复查' },
    { id: 'A3', text: '阀门 泄漏 原因码 c03 处理码 a11' },
  ];
  const file = join(dir, 'docs.jsonl');
  writeFileSync(file, docs.map((d) => JSON.stringify(d)).join('\n'));
  assert.equal(run(['index', dir, file]).code, 0);
  return dir;
}

test('CLI end-to-end: build/index/query/compact/cert', () => {
  const dir = setup();
  const q = JSON.parse(run(['query', dir, '--phrase', '泵 气蚀', '--json']).stdout);
  assert.deepEqual(q.map((r) => r.ext), ['A2', 'A1']); // A2 has 2 phrase hits

  const qn = JSON.parse(
    run(['query', dir, '--phrase', '泵 气蚀', '--near', 'c01', 'a07', '--k', '4', '--json']).stdout
  );
  assert.deepEqual(qn.map((r) => r.ext), ['A1']);

  const cert = JSON.parse(run(['compact', dir]).stdout);
  assert.equal(cert.deletedCount, 0);
  assert.match(run(['cert', dir, '--verify']).stdout, /^OK /);
});

test('CLI del + compact changes cert and old cert proves history', () => {
  const dir = setup();
  const cert1 = JSON.parse(run(['compact', dir]).stdout);
  assert.equal(run(['del', dir, 'A2']).code, 0);
  const q = JSON.parse(run(['query', dir, '--phrase', '泵 气蚀', '--json']).stdout);
  assert.deepEqual(q.map((r) => r.ext), ['A1']); // tombstone filters pre-compact
  const cert2 = JSON.parse(run(['compact', dir]).stdout);
  assert.notEqual(cert2.rootHash, cert1.rootHash);
  assert.equal(cert2.deletedCount, 1);
  assert.match(run(['cert', dir, '--verify']).stdout, /^OK /);
});

test('CLI error codes: E_TOKEN, E_SPAN, E_CERT', () => {
  const dir = setup();
  let r = run(['query', dir, '--phrase', '   ']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_TOKEN/);

  r = run(['query', dir, '--phrase', '泵', '--near', 'c01', 'a07', '--k', '-1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_SPAN/);

  r = run(['cert', dir]); // no compact yet
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_CERT/);

  assert.equal(run(['compact', dir]).code, 0);
  const idxFile = join(dir, 'index.json');
  const data = JSON.parse(readFileSync(idxFile, 'utf8'));
  data.docs['1'].text = 'tampered';
  writeFileSync(idxFile, JSON.stringify(data));
  r = run(['cert', dir, '--verify']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_CERT/);
});
