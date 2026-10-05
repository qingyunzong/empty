#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { run } = require('./src/simulator');
const { ProtocolError } = require('./src/errors');

const USAGE = `Usage: node cli.js <ops.json> --cap <n> [options]

Options:
  --cap <n>          daily budget cap (required, >= 0)
  --seed <n>         PRNG seed for the lossy channel (default 1)
  --loss <p>         packet loss probability in [0,1) (default 0)
  --base-timeout <n> initial retransmission timeout in ticks (default 4)
  --max-retries <n>  max transmission attempts per command (default 8)
  -h, --help         show this help

Exit codes: 0 ok, 1 internal error, 2 usage/IO error,
            3 protocol error, 5 budget insufficient (state unchanged)`;

function parseArgs(argv) {
  const args = { seed: 1, loss: 0, baseTimeout: 4, maxRetries: 8 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--cap':
        args.cap = Number(take());
        break;
      case '--seed':
        args.seed = Number(take());
        break;
      case '--loss':
        args.loss = Number(take());
        break;
      case '--base-timeout':
        args.baseTimeout = Number(take());
        break;
      case '--max-retries':
        args.maxRetries = Number(take());
        break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
        positional.push(a);
    }
  }
  args.file = positional[0] ?? null;
  return args;
}

// Returns the process exit code. `io` is injectable for tests:
// { out(line), err(line) } default to console.log/console.error.
function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`usage error: ${err.message}`);
    io.err(USAGE);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  if (!args.file || !Number.isFinite(args.cap)) {
    io.err('usage error: <ops.json> and --cap <n> are required');
    io.err(USAGE);
    return 2;
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (err) {
    io.err(`error: cannot read ops file ${args.file}: ${err.message}`);
    return 2;
  }

  try {
    const report = run(doc, {
      cap: args.cap,
      seed: args.seed,
      loss: args.loss,
      baseTimeout: args.baseTimeout,
      maxRetries: args.maxRetries,
    });
    io.out(JSON.stringify(report, null, 2));
    if (report.failure && report.failure.type === 'budget') {
      io.err(`budget insufficient: ${report.failure.reason}`);
      return 5;
    }
    return 0;
  } catch (err) {
    if (err instanceof ProtocolError) {
      if (err.report) io.out(JSON.stringify(err.report, null, 2));
      io.err(`protocol error: ${err.message}`);
      return 3;
    }
    io.err(`internal error: ${err.stack || err}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, parseArgs, USAGE };
