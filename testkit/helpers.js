import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'lot-genealogy.js');

export function tmpdir(prefix = 'lot') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// The sandbox swallows piped stdio of node children, so capture via files.
export function cli(args, { env = {}, input } = {}) {
  const dir = tmpdir('lot-cli-io');
  const outPath = path.join(dir, 'stdout');
  const errPath = path.join(dir, 'stderr');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: [input !== undefined ? 'pipe' : 'ignore', outFd, errFd],
      input,
      encoding: 'utf8',
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    code: res.status,
    spawnError: res.error,
    stdout: fs.readFileSync(outPath, 'utf8').trim(),
    stderr: fs.readFileSync(errPath, 'utf8').trim(),
    json() { return JSON.parse(this.stdout.split('\n')[0]); },
    errJson() { return this.stderr ? JSON.parse(this.stderr.split('\n').pop()) : null; },
  };
}

export function addLot(dir, site, id, mass, ts, extra = []) {
  return cli(['add', '--dir', dir, '--site', site, '--lot', id, '--mass', String(mass), '--ts', String(ts), ...extra]);
}

export function addEvent(dir, site, op, ins, outs, ts) {
  const fmt = (list) => list.map(([lot, mass]) => `${lot}:${mass}`).join(',');
  return cli(['add', '--dir', dir, '--site', site, '--op', op, '--in', fmt(ins), '--out', fmt(outs), '--ts', String(ts)]);
}
