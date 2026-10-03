#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Framer } = require('./lib/framer');
const { Gateway } = require('./lib/gateway');
const { decodeHex } = require('./lib/hex');
const { ParseError } = require('./lib/frame');

const USAGE = `Usage: node cli.js [--in trace.hex] [--out out.ndjson] [--clock 0] [--timeout N] [--retries N]

Reads a hex-encoded PLC frame stream (file or stdin), emits NDJSON events and
a final certificate. Exit codes: 0 ok, 2 parse error, 3 protocol violation.
--clock 0 selects the deterministic virtual clock (offline default).`;

function parseArgs(argv) {
  const args = { in: null, out: null, clock: 0, timeout: 2, retries: 3, help: false };
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${argv[i]}`);
      return argv[++i];
    };
    switch (argv[i]) {
      case '--in': args.in = value(); break;
      case '--out': args.out = value(); break;
      case '--clock': args.clock = Number(value()); break;
      case '--timeout': args.timeout = Number(value()); break;
      case '--retries': args.retries = Number(value()); break;
      case '--help':
      case '-h': args.help = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  for (const key of ['clock', 'timeout', 'retries']) {
    if (!Number.isFinite(args[key]) || args[key] < 0) throw new Error(`invalid --${key}`);
  }
  return args;
}

// Pure core: hex text in -> { code, output }. Also usable from tests.
function execute(args, text) {
  const lines = [];
  let code = 0;
  try {
    const bytes = decodeHex(text);
    const framer = new Framer();
    const gateway = new Gateway({ timeout: args.timeout, maxRetries: args.retries });
    const handle = (frames) => {
      for (const frame of frames) {
        for (const ev of gateway.ingest(frame)) lines.push(JSON.stringify(ev));
      }
    };
    try {
      const CHUNK = 1024; // chunked feed: framer must survive arbitrary splits
      for (let off = 0; off < bytes.length; off += CHUNK) {
        handle(framer.push(bytes.subarray(off, off + CHUNK)));
      }
      handle(framer.end());
    } catch (err) {
      handle(framer.frames.splice(0)); // frames parsed before the error
      throw err;
    }
    for (const ev of gateway.finish()) lines.push(JSON.stringify(ev));
    if (gateway.error) {
      lines.push(JSON.stringify({ error: gateway.error }));
      code = 3;
    }
  } catch (err) {
    if (err instanceof ParseError) {
      lines.push(JSON.stringify({ error: { code: err.code, offset: err.offset } }));
      code = 2;
    } else {
      throw err;
    }
  }
  return { code, output: lines.length === 0 ? '' : `${lines.join('\n')}\n` };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`cli: ${err.message}\n${USAGE}\n`);
    return 64;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let text;
  try {
    text = args.in === null ? fs.readFileSync(0, 'utf8') : fs.readFileSync(args.in, 'utf8');
  } catch (err) {
    process.stderr.write(`cli: cannot read input: ${err.message}\n`);
    return 66;
  }
  const { code, output } = execute(args, text);
  if (args.out) fs.writeFileSync(args.out, output);
  else process.stdout.write(output);
  return code;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, execute, parseArgs, USAGE };
