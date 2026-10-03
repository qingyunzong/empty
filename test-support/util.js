import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

export function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

function tryParse(text) {
  try { return JSON.parse(text.trim()); } catch { return null; }
}

// NOTE: this sandbox drops grandchild output on piped stdio, so stdout/stderr
// are captured via temp files instead of pipes.
export function run(dir, args) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(dir, '.out.log');
    const errFile = path.join(dir, '.err.log');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const child = spawn(process.execPath, [CLI, '--dir', dir, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      const stdout = fs.readFileSync(outFile, 'utf8').trim();
      const stderr = fs.readFileSync(errFile, 'utf8').trim();
      resolve({ code, stdout, stderr, json: tryParse(stdout), errJson: tryParse(stderr) });
    });
  });
}

export async function ok(dir, ...args) {
  const r = await run(dir, args);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  assert.ok(r.json?.ok, `expected ok JSON, got: ${r.stdout}`);
  return r.json;
}

export async function fail(dir, ...args) {
  const r = await run(dir, args);
  assert.notEqual(r.code, 0, `expected non-zero exit, got 0: ${r.stdout}`);
  assert.ok(r.errJson?.error?.code, `expected error JSON on stderr, got: ${r.stderr}`);
  return r.errJson.error;
}

export function tx(dir, ops) {
  return ok(dir, 'tx', JSON.stringify({ ops }));
}

export function seedAccounts(dir, n, { amount = 1000, flags = ['R0', 'R1', 'R2'] } = {}) {
  const ops = [];
  for (let i = 0; i < n; i++) {
    ops.push({ op: 'insert', account: `A${i}`, amount });
    ops.push({ op: 'risk', account: `A${i}`, flag: flags[i % flags.length] });
  }
  return tx(dir, ops);
}
