'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fee-settle-'));
}

function writeNdjson(filePath, objects) {
  fs.writeFileSync(filePath, objects.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// Invoke the CLI in-process (the sandbox forbids piped subprocesses).
// Returns { code, stdout, stderr }.
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const code = run(args, { out: (s) => (stdout += s), err: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

module.exports = { mulberry32, makeTmpDir, writeNdjson, runCli };
