'use strict';
// Spawns the CLI as a real subprocess. The sandbox blocks pipes for spawned
// node processes, so stdout/stderr are redirected through temp files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'food-trace-stdio-'));
  const outFile = path.join(dir, 'out.txt');
  const errFile = path.join(dir, 'err.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let status;
  let error;
  try {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    status = result.status;
    error = result.error;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status,
    error,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

module.exports = { runCli, CLI };
