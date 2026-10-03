'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withChecksum, encodeFrames } = require('../lib/frame');

const ROOT = path.join(__dirname, '..');

let seqCounter = 0;
function ev(eventId, acct, amount, branchSeq, logicalTs, extra = {}) {
  return withChecksum({ eventId, acct, amount, branchSeq, logicalTs, ...extra });
}

function tmpdir(prefix = 'ledger-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFrames(dir, frames, name = 'frames.bin') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, encodeFrames(frames));
  return file;
}

// NB: this sandbox swallows piped stdio of spawned processes, so stdout and
// stderr are captured through temp files instead of pipes.
function runCapturing(args, env = {}) {
  const tag = `cap-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), `${tag}.out`);
  const errFile = path.join(os.tmpdir(), `${tag}.err`);
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  res.stdout = fs.readFileSync(outFile, 'utf8');
  res.stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return res;
}

function runCli(framesFile, stateDir, env = {}) {
  return runCapturing([path.join(ROOT, 'cli.js'), framesFile, '--state-dir', stateDir], env);
}

function runVerify(certFile) {
  return runCapturing([path.join(ROOT, 'verify.js'), certFile]);
}

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

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { ROOT, ev, tmpdir, writeFrames, runCli, runVerify, mulberry32, permutations, shuffled, seqCounter };
