#!/usr/bin/env node
'use strict';
const { scan, execute, buildCert } = require('./lib/core');
const { LedgerError } = require('./lib/util');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    }
  }
  return opts;
}

const USAGE = 'usage: node cli.js scan|apply|resume|cert [--journal journal.ndjson] [--dir .state] [--batch N]';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const journal = typeof opts.journal === 'string' ? opts.journal : 'journal.ndjson';
  const dir = typeof opts.dir === 'string' ? opts.dir : '.state';
  const batchSize = typeof opts.batch === 'string' ? parseInt(opts.batch, 10) : undefined;
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize <= 0)) {
    throw new LedgerError('bad-arg', '--batch must be a positive integer', { batch: opts.batch });
  }
  let out;
  switch (cmd) {
    case 'scan':
      out = scan({ journal, dir });
      break;
    case 'apply':
    case 'resume':
      out = execute({ journal, dir, batchSize });
      break;
    case 'cert':
      out = buildCert({ journal, dir });
      break;
    default:
      process.stderr.write(JSON.stringify({ error: { code: 'usage', message: USAGE } }) + '\n');
      process.exitCode = 1;
      return;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

try {
  main();
} catch (err) {
  if (err instanceof LedgerError) {
    process.stderr.write(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }) + '\n');
    process.exitCode = 2;
  } else {
    process.stderr.write(JSON.stringify({ error: { code: 'internal', message: String((err && err.stack) || err) } }) + '\n');
    process.exitCode = 1;
  }
}
