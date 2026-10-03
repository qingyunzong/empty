'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dose-test-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

const PUMPS = {
  pumps: [
    { pump_id: 'PAC-1', max_dose: 500 },
    { pump_id: 'PAM-1', max_dose: 100 },
  ],
};

// Writes plan.json + pumps.json into dir, returns paths.
function setup(dir, doses) {
  const plan = path.join(dir, 'plan.json');
  const pumps = path.join(dir, 'pumps.json');
  writeJson(plan, { doses });
  writeJson(pumps, PUMPS);
  return { plan, pumps };
}

// Note: spawnSync is not permitted in this environment, use async spawn.
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function exec(dir, env = {}) {
  return runCli(
    ['exec', '--plan', path.join(dir, 'plan.json'), '--journal', path.join(dir, 'j'), '--out', path.join(dir, 'out')],
    env,
  );
}

function recover(dir, env = {}) {
  return runCli(['recover', '--journal', path.join(dir, 'j')], env);
}

function ledgerFile(dir) {
  return path.join(dir, 'out', 'dose_ledger.jsonl');
}

function readLedger(dir) {
  const file = ledgerFile(dir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function totals(dir) {
  const perSlot = {};
  let total = 0;
  for (const e of readLedger(dir)) {
    perSlot[e.key] = (perSlot[e.key] || 0) + e.dose;
    total += e.dose;
  }
  return { total, perSlot };
}

module.exports = { CLI, tmpdir, writeJson, setup, runCli, exec, recover, readLedger, totals, ledgerFile };
