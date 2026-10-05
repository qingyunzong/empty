import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// NOTE: this sandbox cannot capture child-process pipes, so output is
// redirected through temp files and the exit code through a marker file.
export function runCli(args, { input } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toollife-cli-'));
  const outF = join(dir, 'out');
  const errF = join(dir, 'err');
  const codeF = join(dir, 'code');
  let cmd = `${sh(process.execPath)} ${sh(CLI)} ${args.map(sh).join(' ')}`;
  if (input !== undefined) {
    const inF = join(dir, 'in');
    writeFileSync(inF, input);
    cmd += ` <${sh(inF)}`;
  }
  cmd += ` >${sh(outF)} 2>${sh(errF)}; echo $? >${sh(codeF)}`;
  spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' });
  const stdout = readFileSync(outF, 'utf8');
  const stderr = readFileSync(errF, 'utf8');
  const code = Number(readFileSync(codeF, 'utf8').trim());
  return {
    code,
    stdout,
    stderr,
    json() { return JSON.parse(stdout); },
    errJson() { return JSON.parse(stderr); },
  };
}

export function writeLog(events) {
  const dir = mkdtempSync(join(tmpdir(), 'toollife-'));
  const file = join(dir, 'log.jsonl');
  const text = events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  writeFileSync(file, `${text}\n`);
  return file;
}

export function budgetSet({ order, operation, segment }) {
  const evs = [];
  if (order !== undefined) evs.push({ type: 'budget', id: 'b-order', level: 'order', order: 'O1', limit: order, causes: [] });
  if (operation !== undefined) evs.push({ type: 'budget', id: 'b-op', level: 'operation', order: 'O1', op: 'P1', limit: operation, causes: [] });
  if (segment !== undefined) evs.push({ type: 'budget', id: 'b-seg', level: 'segment', order: 'O1', op: 'P1', seg: 'S1', limit: segment, causes: [] });
  return evs;
}

export function cut(id, length, causes = [], tool = 'T1') {
  return { type: 'cut', id, tool, order: 'O1', op: 'P1', seg: 'S1', length, causes };
}

export function measure(id, length, causes = [], tool = 'T1') {
  return { type: 'measure', id, tool, order: 'O1', op: 'P1', seg: 'S1', length, causes };
}
