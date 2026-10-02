'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'devlog-'));
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function runCli(args) {
  const { run } = require('../src/cli');
  const stdout = [];
  const stderr = [];
  const status = run(args, {
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
  });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cmpRecord(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.seq - b.seq;
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

module.exports = { tmpDir, writeJsonl, runCli, mulberry32, cmpRecord, globToRegex, CLI };
