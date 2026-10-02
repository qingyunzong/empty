#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { applyPatch, recover } = require('./src/patcher');
const { PatchError } = require('./src/ops');

const USAGE = `usage:
  node cli.js apply   --pkg <dir> --patch <patch.json> [--fail-at=N]
  node cli.js recover --pkg <dir>

exit codes: 0 success, 1 rejection/error, 2 simulated crash`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      } else {
        opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0];
  const pkg = opts.pkg;

  if ((cmd !== 'apply' && cmd !== 'recover') || typeof pkg !== 'string') {
    console.error(USAGE);
    process.exit(1);
  }
  if (!fs.existsSync(pkg) || !fs.statSync(pkg).isDirectory()) {
    fail(`package dir not found: ${pkg}`);
  }

  try {
    if (cmd === 'recover') {
      const result = recover(pkg);
      console.log(result.recovered ? `recovered: ${result.action}, version ${result.version}` : 'nothing to recover');
      return;
    }

    if (typeof opts.patch !== 'string') fail('apply requires --patch <file>');
    let patch;
    try {
      patch = JSON.parse(fs.readFileSync(opts.patch, 'utf8'));
    } catch (err) {
      fail(`cannot read patch: ${err.message}`);
    }

    let failAt = null;
    if (opts['fail-at'] !== undefined) {
      failAt = Number(opts['fail-at']);
      if (!Number.isInteger(failAt) || failAt < 1) fail('--fail-at must be a positive integer');
    }

    const result = applyPatch(pkg, patch, { failAt });
    console.log(`committed ${result.applied} op(s), version ${result.version}`);
  } catch (err) {
    if (err instanceof PatchError) fail(err.message);
    throw err;
  }
}

main();
