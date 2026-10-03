import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/plan-sync.js', import.meta.url));

export function cli(args, { env } = {}) {
  // The sandboxed runtime swallows pipe output of nested node processes,
  // so capture child stdio via temporary files instead of pipes.
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plansync-io-'));
  const outPath = path.join(ioDir, 'stdout');
  const errPath = path.join(ioDir, 'stderr');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  fs.rmSync(ioDir, { recursive: true, force: true });
  return {
    code: r.status,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
    errJson: () => JSON.parse(stderr),
  };
}

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plansync-'));
}

export function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

export function masterPlan() {
  return {
    budget: 40,
    machines: [
      { id: 'M1', caps: ['cut', 'weld', 'paint'] },
      { id: 'M2', caps: ['cut', 'paint'] },
    ],
    jobs: [
      { id: 'J1', due: 20, weight: 2, ops: [
        { id: 'o1', cap: 'cut', dur: 4 },
        { id: 'o2', cap: 'weld', dur: 3 },
        { id: 'o3', cap: 'paint', dur: 2 },
      ] },
      { id: 'J2', due: 16, weight: 1, ops: [
        { id: 'o1', cap: 'cut', dur: 5 },
        { id: 'o2', cap: 'paint', dur: 4 },
      ] },
    ],
    schedule: { M1: ['J1.o1', 'J1.o2', 'J2.o1'], M2: ['J1.o3', 'J2.o2'] },
  };
}

export function initPair(root, plan = masterPlan()) {
  const planPath = path.join(root, 'plan.json');
  writeJson(planPath, plan);
  const a = path.join(root, 'A');
  const b = path.join(root, 'B');
  expectOk(cli(['init', '--dir', a, '--node', 'A', '--plan', '@' + planPath]));
  expectOk(cli(['init', '--dir', b, '--node', 'B', '--plan', '@' + planPath]));
  return { a, b, planPath };
}

export function expectOk(r) {
  if (r.code !== 0) throw new Error(`expected exit 0, got ${r.code}: ${r.stderr}`);
  return r;
}
