'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeCase(obligations, constraints) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netsettle-'));
  fs.writeFileSync(path.join(dir, 'obligations.json'), JSON.stringify({ obligations }));
  fs.writeFileSync(path.join(dir, 'constraints.json'), JSON.stringify(constraints));
  return dir;
}

// Note: this sandbox cannot pipe grandchild stdio back to the parent, so the
// child's stdout/stderr are redirected to files and read back after exit.
function runCli(dir, command, extraArgs = [], env = {}) {
  const outFile = path.join(dir, `stdout-${command}-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const errFile = path.join(dir, `stderr-${command}-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let res;
  try {
    res = spawnSync(
      process.execPath,
      [
        CLI,
        command,
        `--obligations=${path.join(dir, 'obligations.json')}`,
        `--constraints=${path.join(dir, 'constraints.json')}`,
        `--state=${path.join(dir, 'state')}`,
        ...extraArgs,
      ],
      { stdio: ['ignore', outFd, errFd], env: { ...process.env, ...env } },
    );
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: res.status,
    error: res.error,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function statePath(dir, name) {
  return path.join(dir, 'state', name);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { CLI, makeCase, runCli, statePath, mulberry32 };
