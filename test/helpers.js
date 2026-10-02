'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mes-test-'));
}

function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function writeText(dir, name, text) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

function runCliIn(dir, extraArgs = []) {
  return runCli([
    '--policies', path.join(dir, 'policies.json'),
    '--requests', path.join(dir, 'requests.jsonl'),
    '--decisions', path.join(dir, 'decisions.jsonl'),
    '--audit', path.join(dir, 'audit.log'),
    ...extraArgs,
  ]);
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

module.exports = { CLI, tmpdir, writeJson, writeText, runCli, runCliIn, readJsonl };
