'use strict';

// The sandboxed test environment cannot pipe stdio from grandchild
// processes (spawnSync reports EPERM and output is lost). Redirecting
// child stdio to files works reliably, so all child-process tests route
// stdout/stderr through temp files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function spawnNode(args, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kvstore-spawn-'));
  const outPath = path.join(tmp, 'stdout.txt');
  const errPath = path.join(tmp, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  try {
    const result = spawnSync(process.execPath, args, {
      ...opts,
      stdio: ['ignore', outFd, errFd],
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: fs.readFileSync(errPath, 'utf8'),
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { spawnNode };
