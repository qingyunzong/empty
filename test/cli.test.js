import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL(import.meta.url)));
const cli = path.join(root, '..', 'cli.js');
const example = (name) => path.join(root, '..', 'examples', name);

function run(args) {
  // The sandbox swallows grandchild stdout on inherited pipes, so capture
  // output and the exit code through files via a shell wrapper.
  const dir = mkdtempSync(path.join(tmpdir(), 'linearize-cli-'));
  const outFile = path.join(dir, 'out');
  const errFile = path.join(dir, 'err');
  const codeFile = path.join(dir, 'code');
  const quoted = [cli, ...args].map((a) => `'${a}'`).join(' ');
  spawnSync('bash', ['-c',
    `${process.execPath} ${quoted} >'${outFile}' 2>'${errFile}'; printf %s $? >'${codeFile}'`,
  ], { encoding: 'utf8' });
  return {
    code: Number(readFileSync(codeFile, 'utf8')),
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

test('CLI: linearizable history exits 0 with witness and audit values', () => {
  const { code, stdout } = run(['linearize', example('partial-cancel.json')]);
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'LINEARIZABLE');
  assert.equal(out.witness.length, 4);
  assert.deepEqual(out.audits, [{ id: 'a1', holdId: 'H1', frozen: 0, captured: 30, available: 0 }]);
});

test('CLI: capture after cancel exits 1 with the minimal conflict set', () => {
  const { code, stdout } = run(['linearize', example('capture-after-cancel.json')]);
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'NOT_LINEARIZABLE');
  assert.deepEqual([...out.conflict].sort(), ['c1', 'h1', 'x1']);
});

test('CLI: negative capture exits 2 with INVALID_HISTORY', () => {
  const { code, stdout } = run(['linearize', example('invalid-negative.json')]);
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'INVALID_HISTORY');
  assert.ok(out.errors.some((e) => e.includes('negative capture')));
});

test('CLI: expired capture exits 2 with INVALID_HISTORY', () => {
  const { code, stdout } = run(['linearize', example('invalid-expired.json')]);
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'INVALID_HISTORY');
  assert.ok(out.errors.some((e) => e.includes('expired request')));
});

test('CLI: usage error exits 3', () => {
  const { code } = run([]);
  assert.equal(code, 3);
});
