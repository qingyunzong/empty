'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sync-${prefix}-`));
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function writeNdjson(file, events) {
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

module.exports = { CLI, tmpdir, runCli, writeNdjson, execFileSync };
