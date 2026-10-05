#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { runOps } = require('./scheduler');

// Pure-ish entry point: returns {stdout, stderr, exitCode} without touching
// process globals, so it can be unit-tested in-process.
function execute(argv) {
  const args = argv.slice(2);
  let opsFile = null;
  const opts = { cap: undefined, seed: 1, lossRate: 0.2, baseDelay: 100, maxAttempts: 8 };
  const stderr = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--cap') opts.cap = Number(args[(i += 1)]);
    else if (arg === '--seed') opts.seed = Number(args[(i += 1)]);
    else if (arg === '--loss') opts.lossRate = Number(args[(i += 1)]);
    else if (arg === '--base-delay') opts.baseDelay = Number(args[(i += 1)]);
    else if (arg === '--max-attempts') opts.maxAttempts = Number(args[(i += 1)]);
    else if (arg.startsWith('--')) {
      stderr.push(`unknown option: ${arg}`);
      return { stdout: '', stderr: `${stderr.join('\n')}\n${USAGE}\n`, exitCode: 2 };
    } else if (opsFile === null) {
      opsFile = arg;
    } else {
      stderr.push(`unexpected argument: ${arg}`);
      return { stdout: '', stderr: `${stderr.join('\n')}\n${USAGE}\n`, exitCode: 2 };
    }
  }
  if (!opsFile || opts.cap === undefined || !Number.isFinite(opts.cap) || opts.cap < 0) {
    return { stdout: '', stderr: `${USAGE}\n`, exitCode: 2 };
  }
  let ops;
  try {
    ops = JSON.parse(fs.readFileSync(opsFile, 'utf8'));
  } catch (err) {
    return { stdout: '', stderr: `protocol error: cannot read/parse ops file: ${err.message}\n`, exitCode: 3 };
  }
  const result = runOps(ops, opts);
  for (const err of result.errors) {
    stderr.push(`${err.type}: ${err.message}${err.id !== undefined ? ` (id=${err.id})` : ''}`);
  }
  return {
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
    exitCode: result.exitCode,
  };
}

const USAGE =
  'usage: node cli.js <ops.json> --cap <n> [--seed <n>] [--loss <p>] [--base-delay <ms>] [--max-attempts <n>]';

function main(argv) {
  const { stdout, stderr, exitCode } = execute(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { execute };
