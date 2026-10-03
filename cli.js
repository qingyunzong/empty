#!/usr/bin/env node
'use strict';

const { runGateway, CrashError, EXIT_CRASH } = require('./lib/run');

function usage() {
  console.error('usage: node cli.js <frames.bin> [--budget N] [--ttl T] [--fresh]');
  console.error('  --budget N   total budget cap (default 1000)');
  console.error('  --ttl T      reservation TTL in virtual ticks (default 100)');
  console.error('  --fresh      discard any existing <frames.bin>.log instead of recovering from it');
  console.error('  env GW_CRASH_AT=pre:N|log:N|ack:N  simulate a crash at request N');
  process.exit(64);
}

function parseArgs(argv) {
  const opts = { input: null, budget: 1000, ttl: 100, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--budget') opts.budget = Number(argv[++i]);
    else if (arg === '--ttl') opts.ttl = Number(argv[++i]);
    else if (arg === '--fresh') opts.fresh = true;
    else if (arg.startsWith('--')) usage();
    else if (opts.input === null) opts.input = arg;
    else usage();
  }
  if (opts.input === null) usage();
  if (!Number.isInteger(opts.budget) || opts.budget < 0) usage();
  if (!Number.isInteger(opts.ttl) || opts.ttl < 0) usage();
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
try {
  process.exit(runGateway({ ...opts, crashAt: process.env.GW_CRASH_AT || '' }));
} catch (err) {
  if (err instanceof CrashError) process.exit(EXIT_CRASH);
  throw err;
}
