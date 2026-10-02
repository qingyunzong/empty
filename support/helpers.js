import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/plan.js', import.meta.url));

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
}

export function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: opts.input,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function writeScript(dir, src) {
  const p = path.join(dir, `script-${Math.random().toString(36).slice(2)}.plan`);
  fs.writeFileSync(p, src);
  return p;
}
