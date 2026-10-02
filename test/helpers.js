'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../src/cli');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evgw-'));
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function writeJsonl(dir, name, records) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Spawned run: exit codes propagate, but stdout/stderr pipes may be swallowed
// by restricted sandboxes, so only assert on exit codes here.
function runCli(argv) {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// In-process CLI run with captured output.
function runCliInProc(argv) {
  const outLines = [];
  const errLines = [];
  const code = run(argv, { out: (s) => outLines.push(s), err: (s) => errLines.push(s) });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

function stdoutJsonl(stdout) {
  return stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

module.exports = { CLI, makeDir, writeJson, writeJsonl, readJsonl, runCli, runCliInProc, stdoutJsonl };
