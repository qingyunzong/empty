import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';

export function mkLedger() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-ledger-'));
}

export function runCli(dir, args, env = {}) {
  const res = run(args, { LEDGER_DIR: dir, ...env });
  return { code: res.code, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

export function ok(res) {
  assert.equal(res.code, 0, `expected exit 0, stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

export function fail(res, code) {
  assert.equal(res.code, code, `expected exit ${code}, stdout: ${res.stdout} stderr: ${res.stderr}`);
  return JSON.parse(res.stderr);
}
