#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseJsonl, reconcile, ReconError } = require('../lib/recon');

const USAGE = 'usage: recon <bank.jsonl> <core.jsonl> <adj.jsonl> --out entries.jsonl --conflicts conflicts.json [--tol N]';

function parseArgs(argv) {
  const positional = [];
  const opts = { out: null, conflicts: null, tol: '0' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--conflicts') opts.conflicts = argv[++i];
    else if (arg === '--tol') opts.tol = argv[++i];
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else if (arg.startsWith('--conflicts=')) opts.conflicts = arg.slice('--conflicts='.length);
    else if (arg.startsWith('--tol=')) opts.tol = arg.slice('--tol='.length);
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg.startsWith('--')) throw new ReconError(`unknown option: ${arg}`, 2);
    else positional.push(arg);
  }
  return { positional, opts };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ReconError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return err.exitCode;
    }
    throw err;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const { positional, opts } = parsed;
  if (positional.length !== 3 || !opts.out || !opts.conflicts) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const tol = Number(opts.tol);
  if (!Number.isFinite(tol) || tol < 0) {
    process.stderr.write(`error: tolerance must be a non-negative number, got ${JSON.stringify(opts.tol)}\n`);
    return 19;
  }
  try {
    const bank = parseJsonl(fs.readFileSync(positional[0], 'utf8'), 'bank');
    const core = parseJsonl(fs.readFileSync(positional[1], 'utf8'), 'core');
    const adj = parseJsonl(fs.readFileSync(positional[2], 'utf8'), 'adj');
    const { entries, conflicts } = reconcile({ bank, core, adj, tol });
    fs.writeFileSync(opts.out, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    fs.writeFileSync(opts.conflicts, `${JSON.stringify(conflicts, null, 2)}\n`);
    process.stdout.write(`entries=${entries.length} conflicts=${conflicts.length} -> ${opts.out}, ${opts.conflicts}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ReconError) {
      process.stderr.write(`error: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
