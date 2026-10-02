import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

export function tmpdir(prefix = 'evpack-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Runs the CLI in-process; exit code / stdout / stderr contract is identical
// to the bin/evpack.js wrapper (which cannot be spawned inside the sandbox).
export function runCli(args) {
  const r = run(args);
  return {
    status: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    json: r.stdout.trim() ? JSON.parse(r.stdout) : null,
    errJson: r.stderr.trim() ? JSON.parse(r.stderr) : null,
  };
}

export function makePack(dir, count, { members = ['a', 'b'] } = {}) {
  runCli(['init', dir, '--members', members.join(',')]);
  for (let i = 0; i < count; i++) {
    const r = runCli(['add', dir, '--data', JSON.stringify({ seq: i, tag: `item-${i}` })]);
    if (r.status !== 0) throw new Error('add failed: ' + r.stderr);
  }
  return dir;
}

export function copyPack(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
  return dst;
}
