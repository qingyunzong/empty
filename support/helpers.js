import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tradehist-'));
}

// Note: this sandbox swallows piped stdout of nested node processes,
// so the child's stdout is redirected to a temp file via file descriptor.
export function runCli(args, { store } = {}) {
  const full = [path.join(root, 'cli.js'), ...args];
  if (store) full.push('--store', store);
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-out-')), 'out.txt');
  const fd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, full, { stdio: ['ignore', fd, 'pipe'] });
  fs.closeSync(fd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    // leave null
  }
  return { code: res.status, stdout, stderr: res.stderr, json };
}
