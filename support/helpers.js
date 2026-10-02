import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/plan-sync.js', import.meta.url));

export function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plansync-'));
}

export function runCli(args, { env } = {}) {
  const e = { ...process.env };
  delete e.PLAN_SYNC_FAIL_AT;
  Object.assign(e, env || {});
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plansync-out-')), 'stdout.txt');
  const fd = fs.openSync(outFile, 'w');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: e,
    stdio: ['ignore', fd, 'pipe'],
    encoding: 'utf8',
  });
  fs.closeSync(fd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  const tryParse = (s) => {
    try { return JSON.parse(s.trim()); } catch { return null; }
  };
  return {
    code: r.status,
    stdout: stdout.trim(),
    stderr: (r.stderr || '').trim(),
    json: tryParse(stdout),
    errJson: tryParse(r.stderr || ''),
  };
}

export function basePlan() {
  return {
    jobs: [
      { id: 'j1', due: 6, weight: 1 },
      { id: 'j2', due: 4, weight: 2 },
    ],
    ops: [
      { id: 'o1', job: 'j1', machine: 'M1', start: 0, dur: 2, preds: [], machines: ['M1', 'M2'] },
      { id: 'o2', job: 'j1', machine: 'M1', start: 2, dur: 2, preds: ['o1'], machines: ['M1', 'M2'] },
      { id: 'o3', job: 'j2', machine: 'M2', start: 0, dur: 3, preds: [], machines: ['M2', 'M3'] },
    ],
  };
}

export function seedDir(root, name, plan = basePlan(), constraints = { budget: 100 }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(dir, 'constraints.json'), JSON.stringify(constraints));
  return dir;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
