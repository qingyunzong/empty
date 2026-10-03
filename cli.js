#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { joinStreams } = require('./lib/join');

const USAGE = [
  'usage:',
  '  node cli.js join --trades <trades.jsonl> --cancels <cancels.jsonl> --out <fills.jsonl>',
  'options:',
  '  --summary <path>   also write per-symbol end-of-day summary JSON',
  '  --orphans <path>   also write orphan cancels JSONL',
  '  --late <path>      also write late-join records JSONL',
].join('\n');

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for --${name}`);
      }
      opts[name] = value;
      i += 1;
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function main(argv) {
  const opts = parseArgs(argv);
  const command = opts._.shift();
  if (command !== 'join') {
    console.error(USAGE);
    return 64;
  }
  if (!opts.trades || !opts.cancels || !opts.out) {
    console.error(USAGE);
    return 64;
  }

  let tradesText;
  let cancelsText;
  try {
    tradesText = fs.readFileSync(opts.trades, 'utf8');
    cancelsText = fs.readFileSync(opts.cancels, 'utf8');
  } catch (err) {
    console.error(`io-error: ${err.message}`);
    return 1;
  }

  const result = joinStreams(tradesText, cancelsText);

  fs.writeFileSync(opts.out, toJsonl(result.fills));
  if (opts.summary) fs.writeFileSync(opts.summary, JSON.stringify(result.symbols, null, 2) + '\n');
  if (opts.orphans) fs.writeFileSync(opts.orphans, toJsonl(result.orphanCancels));
  if (opts.late) fs.writeFileSync(opts.late, toJsonl(result.lateJoins));

  for (const err of result.errors) {
    console.error(`row-error ${err.file}:${err.line} ${err.reason}`);
  }
  console.error(
    `fills=${result.fills.length} orphans=${result.orphanCancels.length} ` +
      `late-joins=${result.lateJoins.length} row-errors=${result.errors.length}`,
  );
  return result.errors.length > 0 ? 2 : 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs };
