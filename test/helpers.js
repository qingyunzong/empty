import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLI = path.resolve('src/cli.js');

// 注意：本环境中 node 子进程的管道 stdout 会被吞掉，因此一律重定向到临时文件再读回。
export function runCli(args, { env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-sync-io-'));
  const outFile = path.join(tmp, 'out');
  const errFile = path.join(tmp, 'err');
  const envPairs = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' ');
  const cmd = `${envPairs} ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${args.map((a) => JSON.stringify(a)).join(' ')} >${JSON.stringify(outFile)} 2>${JSON.stringify(errFile)}`;
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const parse = (s) => {
    const t = s.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return { raw: t };
    }
  };
  const rawOut = read(outFile);
  const rawErr = read(errFile);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { code: r.status, stdout: parse(rawOut), stderr: parse(rawErr), rawOut, rawErr };
}

export function tmpStore(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `maint-sync-${label}-`));
}

export function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

export function readIndex(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
}

export function readLogEvents(dir) {
  const p = path.join(dir, 'events.log');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).event);
}

export function emit(store, site, type, order, extra = []) {
  return runCli(['emit', '--store', store, '--site', site, '--type', type, '--order', order, ...extra]);
}
