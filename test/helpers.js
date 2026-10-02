'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { GENESIS, computeHash, serializeLog } = require('../src/chain');

const CLI = path.join(__dirname, '..', 'audit.js');

function makeEvents(n, bodyFor) {
  const events = [];
  let prev = GENESIS;
  for (let seq = 1; seq <= n; seq++) {
    const body = bodyFor ? bodyFor(seq) : { amount: seq * 100, currency: 'CNY', memo: `settle-${seq}` };
    const hash = computeHash(prev, body);
    events.push({ seq, prevHash: prev, hash, body });
    prev = hash;
  }
  return events;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

function writeLog(dir, name, events) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, serializeLog(events));
  return p;
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

// Note: spawnSync is blocked in this sandbox (EPERM); use async spawn.
// Piped stdio from spawned children is also unreliable here, so the
// child's stdout/stderr are redirected to temp files and read back.
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const dir = tmpdir();
    const stdoutPath = path.join(dir, 'stdout.txt');
    const stderrPath = path.join(dir, 'stderr.txt');
    const outFd = fs.openSync(stdoutPath, 'w');
    const errFd = fs.openSync(stderrPath, 'w');
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', reject);
    child.on('close', (status) => {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({
        status,
        stdout: fs.readFileSync(stdoutPath, 'utf8'),
        stderr: fs.readFileSync(stderrPath, 'utf8'),
      });
    });
  });
}

module.exports = { makeEvents, tmpdir, writeLog, writeJson, runCli, CLI };
