'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/cli');

const BIN = path.join(__dirname, '..', 'bin', 'calsched.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'calsched-'));
}

function writeJson(dir, name, obj) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

// In-process CLI invocation: captures streams and the exit code without
// spawning a subprocess, so tests run in restricted sandboxes too.
function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
}

function runCliJson(argv, opts) {
  const res = runCli(argv, opts);
  if (res.code !== 0) {
    throw new Error(`cli failed (${res.code}): ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
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

module.exports = { BIN, tmpDir, writeJson, runCli, runCliJson, mulberry32 };
