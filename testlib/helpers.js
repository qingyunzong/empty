import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/interlock.js', import.meta.url));

export function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interlock-'));
  const inDir = path.join(root, 'in');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(inDir, { recursive: true });
  return { root, inDir, outDir };
}

export function writeEvents(inDir, events, name = 'events.jsonl') {
  const lines = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e)));
  fs.writeFileSync(path.join(inDir, name), `${lines.join('\n')}\n`);
}

export function runCli(inDir, outDir, { args = [], env = {} } = {}) {
  // Note: this sandboxed environment breaks child stdio pipes, so stdout and
  // stderr are captured through inherited file descriptors instead.
  const stdoutPath = `${outDir}.stdout.log`;
  const stderrPath = `${outDir}.stderr.log`;
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const result = spawnSync(
    process.execPath,
    [BIN, 'replay', '--in', inDir, '--out', outDir, ...args],
    { env: { ...process.env, ...env }, stdio: ['ignore', stdoutFd, stderrFd] },
  );
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: readFile(stdoutPath),
    stderr: readFile(stderrPath),
  };
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function readFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

export function sensor(id, ts, tag, value, extra = {}) {
  return {
    type: 'sensor',
    id,
    eventTs: ts,
    tag,
    value,
    unit: tag === 'pressure' ? 'kPa' : 'C',
    seq: 0,
    ...extra,
  };
}

export function aliveStates(statesLines) {
  const alive = new Map();
  for (const rec of statesLines) {
    const { op, ...rest } = rec;
    const key = JSON.stringify(rest);
    if (op === 'EMIT') alive.set(key, (alive.get(key) ?? 0) + 1);
    else if (op === 'REVOKE') alive.set(key, (alive.get(key) ?? 0) - 1);
  }
  return [...alive.entries()]
    .filter(([, count]) => count > 0)
    .map(([key]) => JSON.parse(key));
}
