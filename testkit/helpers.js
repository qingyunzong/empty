import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Pipe-based stdout capture is unreliable in this sandbox, so the child
// writes to temp files that are read back after exit.
export function runCli(args, { dir, limit } = {}) {
  const full = [...args];
  if (dir) full.push('--data-dir', dir);
  if (limit !== undefined) full.push('--limit', String(limit));
  const outFile = path.join(os.tmpdir(), `fzcli-${process.pid}-${Math.random().toString(36).slice(2)}.out`);
  const errFile = `${outFile}.err`;
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [CLI, ...full], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8').trim();
  const stderr = fs.readFileSync(errFile, 'utf8').trim();
  fs.unlinkSync(outFile);
  fs.unlinkSync(errFile);
  return {
    status: r.status,
    stdout,
    stderr,
    json: stdout ? JSON.parse(stdout) : null,
  };
}
