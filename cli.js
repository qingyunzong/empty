#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { RowError, parseJsonl, parseTradeRow, parseCancelRow } = require('./lib/parse');
const { joinStreams } = require('./lib/join');

const USAGE = 'usage: node cli.js join --trades t.jsonl --cancels c.jsonl --out o.jsonl';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'join') {
    fail(USAGE);
    return;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        trades: { type: 'string' },
        cancels: { type: 'string' },
        out: { type: 'string' },
      },
    }));
  } catch (err) {
    fail(`${err.message}\n${USAGE}`);
    return;
  }
  if (!values.trades || !values.cancels || !values.out) {
    fail(USAGE);
    return;
  }

  try {
    const trades = parseJsonl(readFile(values.trades), values.trades, parseTradeRow);
    const cancels = parseJsonl(readFile(values.cancels), values.cancels, parseCancelRow);
    const result = joinStreams(trades, cancels);

    const fillLines = result.rows.map((row) => JSON.stringify({
      orderId: row.orderId,
      symbol: row.symbol,
      qty: row.qty,
      win: row.win,
      proof: row.proof,
      ...(row.late ? { late: true } : {}),
    }));
    fs.writeFileSync(values.out, fillLines.length ? `${fillLines.join('\n')}\n` : '');

    process.stdout.write(`${JSON.stringify({
      symbols: result.symbols,
      orphans: result.orphans,
      stats: result.stats,
    }, null, 2)}\n`);
  } catch (err) {
    if (err instanceof RowError) {
      fail(`row error: ${err.message}`);
    } else {
      fail(`error: ${err.message}`);
    }
  }
}

main(process.argv.slice(2));
