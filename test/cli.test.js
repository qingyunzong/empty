import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Feed stdin and capture stdout/stderr through real files so the CLI is
// exercised exactly as it would be in production (`node src/cli.js < in`).
function runCli(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reversal-cli-'));
  const inPath = path.join(dir, 'in.ndjson');
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  fs.writeFileSync(inPath, input);
  const fdIn = fs.openSync(inPath, 'r');
  const fdOut = fs.openSync(outPath, 'w');
  const fdErr = fs.openSync(errPath, 'w');
  let status;
  try {
    status = spawnSync(process.execPath, [CLI], { stdio: [fdIn, fdOut, fdErr] }).status;
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
    fs.closeSync(fdErr);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: status, stdout, stderr };
}

test('CLI processes NDJSON and exits 0 on success', () => {
  const input = [
    JSON.stringify({ op: 'add-dep', from: 'a', to: 'b' }),
    JSON.stringify({ op: 'add-dep', from: 'b', to: 'a' }),
    JSON.stringify({ op: 'cancel', tx: 'a', event: 'e1' }),
    JSON.stringify({ op: 'restore', tx: 'b', event: 'e2' }),
    '',
  ].join('\n');
  const { code, stdout, stderr } = runCli(input);
  assert.equal(code, 0, stderr);
  const lines = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { ok: true, op: 'add-dep', from: 'a', to: 'b' });
  // a and b form one SCC: cancelling a reverses both.
  assert.deepEqual(lines[2].affected, ['a', 'b']);
  assert.equal(lines[2].scc.a, lines[2].scc.b);
  assert.equal(lines[2].certificate.root, 'a');
  // Restoring b restores the whole component again.
  assert.deepEqual(lines[3].affected, ['a', 'b']);
});

test('CLI emits JSON error objects and exits 1 on failure', () => {
  const input = [
    JSON.stringify({ op: 'add-dep', from: 'a', to: 'b' }),
    JSON.stringify({ op: 'cancel', tx: 'ghost', event: 'e1' }),
    'not json',
    JSON.stringify({ op: 'cancel', tx: 'a', event: 'e2' }),
    JSON.stringify({ op: 'cancel', tx: 'a', event: 'e3' }),
    JSON.stringify({ op: 'restore', tx: 'a', event: 'e4' }),
    JSON.stringify({ op: 'restore', tx: 'a', event: 'e5' }),
  ].join('\n');
  const { code, stdout } = runCli(input);
  assert.equal(code, 1);
  const lines = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 7);
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].code, 'UNKNOWN_TX');
  assert.equal(lines[2].ok, false); // invalid JSON line
  assert.equal(lines[3].ok, true); // first cancel succeeds
  assert.equal(lines[4].ok, false);
  assert.equal(lines[4].code, 'DUPLICATE_CANCEL');
  assert.equal(lines[5].ok, true); // restore succeeds
  assert.equal(lines[6].ok, false);
  assert.equal(lines[6].code, 'NOT_REVERSED');
  // Error objects carry the offending line number.
  assert.equal(lines[1].line, 2);
  assert.equal(lines[4].line, 5);
});
