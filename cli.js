#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { processBytes } = require('./src/processor');
const { decodeHex } = require('./src/hex');

const USAGE = `Usage: node cli.js [--in trace.hex] [--out out.ndjson] [--clock N]

Reads a hex-encoded PLC frame stream (file or stdin), writes NDJSON
events plus a final certificate (file or stdout).

Exit codes: 0 ok, 2 parse error, 3 protocol violation, 4 usage error.`;

function parseArgs(argv) {
  const opts = { in: null, out: null, clock: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--in' || arg === '--out' || arg === '--clock') {
      if (i + 1 >= argv.length) return { error: `missing value for ${arg}` };
      const value = argv[++i];
      if (arg === '--in') opts.in = value;
      else if (arg === '--out') opts.out = value;
      else {
        if (!/^\d+$/.test(value)) {
          return { error: `--clock must be a non-negative integer, got "${value}"` };
        }
        opts.clock = Number(value);
      }
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { opts };
}

// io: { readStdin(), readFile(p), writeOut(s), writeFile(p, s), writeErr(s) }
function main(argv, io) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    io.writeOut(USAGE + '\n');
    return 0;
  }
  if (parsed.error) {
    io.writeErr(`error: ${parsed.error}\n${USAGE}\n`);
    return 4;
  }
  const { in: inPath, out: outPath, clock } = parsed.opts;

  let text;
  try {
    text = inPath ? io.readFile(inPath) : io.readStdin();
  } catch (err) {
    io.writeErr(`error: cannot read input: ${err.message}\n`);
    return 4;
  }

  const lines = [];
  let exitCode = 0;

  const { bytes, error: hexError } = decodeHex(text);
  if (hexError) {
    lines.push(JSON.stringify({ error: hexError }));
    exitCode = 2;
  } else {
    const result = processBytes(bytes, { timeout: clock });
    for (const ev of result.events) lines.push(JSON.stringify(ev));
    if (result.error) {
      lines.push(JSON.stringify({ error: result.error }));
      exitCode = result.exitCode;
    } else {
      lines.push(JSON.stringify(result.certificate));
    }
  }

  const output = lines.length ? lines.join('\n') + '\n' : '';
  if (outPath) {
    io.writeFile(outPath, output);
  } else {
    io.writeOut(output);
  }
  if (exitCode !== 0) {
    const last = JSON.parse(lines[lines.length - 1]);
    io.writeErr(`error: ${last.error.code} at offset ${last.error.offset}\n`);
  }
  return exitCode;
}

const stdio = {
  readStdin: () => fs.readFileSync(0, 'utf8'),
  readFile: (p) => fs.readFileSync(path.resolve(p), 'utf8'),
  writeOut: (s) => process.stdout.write(s),
  writeFile: (p, s) => fs.writeFileSync(path.resolve(p), s),
  writeErr: (s) => process.stderr.write(s),
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), stdio);
}

module.exports = { main, parseArgs, USAGE };
