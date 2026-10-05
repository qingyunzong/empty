'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');
const CRASH_EXIT = 75;

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'lab-'));
}

function runCli(args) {
  // The sandbox blocks pipe capture for child processes (EPERM), so
  // stdout/stderr are redirected to files and read back.
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cli-'));
  const outPath = path.join(ioDir, 'stdout.txt');
  const errPath = path.join(ioDir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: result.status,
    error: result.error,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

function writeProtocol(dir, obj) {
  const p = path.join(dir, 'protocol.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readJournal(p) {
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function normalizeResult(r) {
  const c = structuredClone(r);
  delete c.generatedAt;
  delete c.compensations;
  delete c.consumed;
  for (const s of Object.values(c.steps)) delete s.attempts;
  return c;
}

function linearProtocol(timeoutOverrides = {}) {
  const t = (id) => (timeoutOverrides[id] == null ? 300 : timeoutOverrides[id]);
  return {
    name: 'linear5',
    steps: [
      { id: 'weigh', kind: 'weigh', produces: ['s.weighed'], timeout: t('weigh') },
      { id: 'dilute', kind: 'dilute', requires: ['s.weighed'], produces: ['s.diluted'], timeout: t('dilute') },
      { id: 'mix', kind: 'mix', requires: ['s.diluted'], produces: ['s.mixed'], timeout: t('mix') },
      { id: 'incubate', kind: 'incubate', requires: ['s.mixed'], produces: ['s.incubated'], timeout: t('incubate') },
      { id: 'measure', kind: 'measure', requires: ['s.incubated'], produces: ['s.result'], timeout: t('measure') },
    ],
  };
}

function branchingProtocol() {
  return {
    name: 'branching',
    steps: [
      { id: 'weigh', kind: 'weigh', produces: ['s.weighed'], timeout: 300 },
      { id: 'dilute', kind: 'dilute', requires: ['s.weighed'], produces: ['s.diluted'], timeout: 300 },
      { id: 'heat', kind: 'incubate', requires: ['s.diluted'], produces: ['s.heated'], timeout: 300 },
      { id: 'cool', kind: 'incubate', requires: ['s.diluted'], produces: ['s.cooled'], timeout: 300 },
      { id: 'combine', kind: 'mix', requires: ['s.heated', 's.cooled'], produces: ['s.final'], timeout: 300 },
    ],
  };
}

module.exports = {
  CLI,
  CRASH_EXIT,
  makeDir,
  runCli,
  writeProtocol,
  readJson,
  readJournal,
  normalizeResult,
  linearProtocol,
  branchingProtocol,
};
