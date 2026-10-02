'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../cli');

const ROOT = path.join(__dirname, '..');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rng, n) {
  const parties = ['A', 'B', 'C', 'D', 'E'];
  const obligations = [];
  for (let i = 0; i < n; i++) {
    const from = parties[Math.floor(rng() * parties.length)];
    let to = from;
    while (to === from) to = parties[Math.floor(rng() * parties.length)];
    obligations.push({
      id: 'o' + (i + 1),
      from,
      to,
      amount: 1 + Math.floor(rng() * 900),
      days: Math.floor(rng() * 4),
      status: 'confirmed',
    });
  }
  const feeBps = 1 + Math.floor(rng() * 50);
  const fixedFee = Math.floor(rng() * 20);
  const freezeBps = 1 + Math.floor(rng() * 100);
  let grossAmount = 0;
  let grossFee = 0;
  let grossFreeze = 0;
  for (const o of obligations) {
    grossAmount += o.amount;
    grossFee += fixedFee + Math.floor((o.amount * feeBps) / 10000);
    grossFreeze += Math.floor((o.amount * freezeBps) / 10000);
  }
  const loose = 1e12;
  const pick = (gross) => (rng() < 0.4 ? loose : Math.floor(gross * (0.3 + rng() * 0.9)));
  const constraints = {
    fee_bps: feeBps,
    fixed_fee: fixedFee,
    freeze_bps: freezeBps,
    max_total_fee: pick(grossFee),
    max_days: rng() < 0.4 ? 99 : Math.floor(rng() * 4),
    max_total_freeze: pick(grossFreeze),
    max_daily_amount: pick(grossAmount),
  };
  return { obligations, constraints };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-test-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function runCli(args, opts = {}) {
  const stdout = [];
  const stderr = [];
  const status = cli.run(args, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

module.exports = { ROOT, mulberry32, randomInstance, makeTmpDir, writeJson, runCli };
