'use strict';
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { run } = require('../src/cli');

const CLI = join(__dirname, '..', 'bin', 'cli.js');

function tmpdirPath() {
  return mkdtempSync(join(tmpdir(), 'risk-patch-'));
}

function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// In-process CLI invocation (spawnSync is restricted in some sandboxes).
function runCli(args) {
  return run(args);
}

module.exports = { tmpdirPath, writeJson, readJson, runCli, CLI };
