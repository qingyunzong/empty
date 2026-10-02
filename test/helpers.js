import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CLI = path.resolve(import.meta.dirname, '..', 'cli.js');

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'labflow-'));
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// NOTE: this sandbox cannot capture child-process pipes via spawnSync, so the
// CLI's stdout/stderr are redirected to files and read back.
export function cli(args) {
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'labflow-io-'));
  const outFile = path.join(io, 'stdout');
  const errFile = path.join(io, 'stderr');
  const quote = (a) => `'${String(a).replaceAll("'", "'\\''")}'`;
  const cmd = [process.execPath, CLI, ...args].map(quote).join(' ')
    + ` >${quote(outFile)} 2>${quote(errFile)}`;
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  return {
    code: r.status,
    stdout: fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '',
    stderr: fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '',
  };
}

export function stateFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

export function journalRecords(journalPath) {
  return fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

export function effectsOf(records) {
  return records.filter((r) => r.type === 'effect').map((r) => ({ step: r.step, produced: r.produced }));
}

// weigh -> [dilute, mix] (parallel branches) -> incubate (join)
export function branchyProtocol(incubateTimeout = 60000) {
  return {
    name: 'branchy',
    inputs: ['sample'],
    steps: [
      { id: 'weigh', op: 'weigh', requires: ['sample'], produces: ['weighed'] },
      { id: 'dilute', op: 'dilute', requires: ['weighed'], produces: ['diluted'] },
      { id: 'mix', op: 'mix', requires: ['weighed'], produces: ['mixed'] },
      { id: 'incubate', op: 'incubate', requires: ['diluted', 'mixed'], produces: ['incubated'], timeout: incubateTimeout },
    ],
  };
}

export function linear5Protocol() {
  return {
    name: 'linear5',
    inputs: ['sample'],
    steps: [
      { id: 's1', op: 'weigh', requires: ['sample'], produces: ['a1'] },
      { id: 's2', op: 'dilute', requires: ['a1'], produces: ['a2'] },
      { id: 's3', op: 'mix', requires: ['a2'], produces: ['a3'] },
      { id: 's4', op: 'incubate', requires: ['a3'], produces: ['a4'], timeout: 100000 },
      { id: 's5', op: 'mix', requires: ['a4'], produces: ['a5'] },
    ],
  };
}

// Sets up a run directory with the given protocol; returns paths.
export function setupRun(protocol) {
  const dir = tmpDir();
  const protocolPath = path.join(dir, 'protocol.json');
  const journalPath = path.join(dir, 'run.jsonl');
  writeJson(protocolPath, protocol);
  return {
    dir,
    protocolPath,
    journalPath,
    stateDir: path.join(dir, 'state'),
    resultPath: path.join(dir, 'result.json'),
    reportPath: path.join(dir, 'recovery_report.json'),
  };
}
