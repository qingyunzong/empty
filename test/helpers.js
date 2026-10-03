'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../src/cli');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'));
}

// Runs the CLI in-process (the sandbox forbids spawning node subprocesses).
function runCli(dir, args) {
  let stdout = '';
  let stderr = '';
  const status = run(['--dir', dir, ...args], {
    out: (obj) => { stdout += JSON.stringify(obj) + '\n'; },
    err: (msg) => { stderr += msg + '\n'; },
  });
  return { status, stdout, stderr, json: tryParse(stdout) };
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Deterministic PRNG for reproducible randomized tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { tmpDir, runCli, mulberry32 };
