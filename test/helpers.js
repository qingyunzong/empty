import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/settle.js', import.meta.url));

export function makeDir() {
  return mkdtempSync(join(tmpdir(), 'settle-test-'));
}

export function write(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

export function read(path) {
  return readFileSync(path, 'utf8');
}

// Runs the CLI in a child process. stdout/stderr are captured via file
// redirection (pipes are not reliable in every sandbox), exit code via close.
export function runCli(args) {
  const dir = makeDir();
  const outPath = join(dir, 'stdout.txt');
  const errPath = join(dir, 'stderr.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', outFd, errFd] });
    child.on('error', (err) => resolve({ status: -1, stdout: '', stderr: String(err) }));
    child.on('close', (status) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({ status, stdout: readFileSync(outPath, 'utf8'), stderr: readFileSync(errPath, 'utf8') });
    });
  });
}

// Deterministic PRNG (LCG) for reproducible random flows.
export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
