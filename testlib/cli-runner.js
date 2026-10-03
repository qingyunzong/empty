// The sandbox breaks spawn stdio pipes, so CLI tests communicate via files:
// input JSONL is written to a file (passed as positional arg), stdout/stderr
// are redirected to files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CLI = new URL('../src/cli.js', import.meta.url).pathname;

export function runCli({ input, stateDir, env } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-run-'));
  const inputFile = path.join(dir, 'input.jsonl');
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  fs.writeFileSync(inputFile, input);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const args = [CLI];
  if (stateDir) args.push('--state', stateDir);
  args.push(inputFile);
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, ...env },
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

export function stdoutLines(run) {
  return run.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
