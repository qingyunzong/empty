import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../../bin/event-trace.js', import.meta.url));

// The sandbox swallows child-process stdio pipes, so redirect to files.
export function runCli(args, { env } = {}) {
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'event-trace-io-'));
  const outFile = path.join(io, 'stdout');
  const errFile = path.join(io, 'stderr');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
      timeout: 30000,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  if (r.error) throw r.error;
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-trace-'));
}

export function jsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export function inputFile(events) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'event-trace-in-')), 'input.jsonl');
  fs.writeFileSync(file, jsonl(events));
  return file;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
