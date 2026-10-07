import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
}

// Run the CLI in-process (the sandbox forbids node spawning node). Crash
// injection is simulated by an exception that unwinds exactly like process.exit.
export function runCli(dir, args, env = {}) {
  const out = [];
  const err = [];
  const status = main(['--dir', dir, ...args], {
    env: { QC_DATA_DIR: dir, ...env },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s)
  });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

export function runOk(dir, args, env = {}) {
  const r = runCli(dir, args, env);
  if (r.status !== 0) throw new Error(`expected exit 0, got ${r.status}: ${r.stderr} (args: ${args.join(' ')})`);
  return JSON.parse(r.stdout);
}

export function readState(dir) {
  return JSON.parse(runCli(dir, ['state']).stdout);
}
