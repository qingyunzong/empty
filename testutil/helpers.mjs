import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'clearing.js');

// This environment cannot reliably pipe stdin/stdout of child processes,
// so CLI tests communicate through temp files instead.
export function runCli(input, { state } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-cli-'));
  const inPath = path.join(dir, 'in.jsonl');
  const outPath = path.join(dir, 'out.jsonl');
  const errPath = path.join(dir, 'err.txt');
  fs.writeFileSync(inPath, input);
  const args = [BIN];
  if (state) args.push('--state', state);
  const inFd = fs.openSync(inPath, 'r');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync(process.execPath, args, {
    stdio: [inFd, outFd, errFd],
    timeout: 60000,
  });
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const result = {
    status: res.status,
    error: res.error,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

export function lines(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
