'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpFile(prefix = 'ledger') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slay-${prefix}-`));
  return path.join(dir, 'data.bin');
}

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* keep null */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

module.exports = { tmpFile, cli, CLI };
