#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Gateway, ConflictError } = require('./lib/gateway');
const { RealClock } = require('./lib/clock');
const { StructuralError } = require('./lib/frame');

const USAGE = `Usage: node cli.js --stream <file.bin> [--out certs.json] [--frames-log frames.log]
                   [--missing-timeout-ms N]

Exit codes: 0 ok, 2 structural error, 6 session conflict.
CRC failures are logged as bad_crc and never terminate the run.`;

function parseArgs(argv) {
  const args = { out: 'certs.json', framesLog: 'frames.log', missingTimeoutMs: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stream') args.stream = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--frames-log') args.framesLog = argv[++i];
    else if (a === '--missing-timeout-ms') args.missingTimeoutMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.stream) {
    console.error(USAGE);
    process.exitCode = args.help ? 0 : 2;
    return;
  }

  const clock = new RealClock();
  const events = [];
  const gw = new Gateway({ clock, missingTimeoutMs: args.missingTimeoutMs, onEvent: (e) => events.push(e) });

  let exitCode = 0;
  try {
    const data = fs.readFileSync(args.stream);
    const CHUNK = 64 * 1024;
    for (let off = 0; off < data.length; off += CHUNK) {
      gw.feed(data.subarray(off, Math.min(off + CHUNK, data.length)));
    }
    gw.end();
  } catch (err) {
    if (err instanceof StructuralError) {
      events.push({ t: clock.now(), event: 'error', kind: 'structural', code: err.code, message: err.message });
      console.error(`structural error (${err.code}): ${err.message}`);
      exitCode = 2;
    } else if (err instanceof ConflictError) {
      console.error(`session conflict: ${err.message}`);
      exitCode = 6;
    } else {
      throw err;
    }
  }

  // Certificates are always flushed (atomically) so committed boards survive
  // truncated tails, structural errors and conflicts.
  writeAtomic(args.out, JSON.stringify({ certs: gw.certs(), stats: gw.stats }, null, 2) + '\n');
  writeAtomic(args.framesLog, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.error(`frames=${gw.stats.frames} commits=${gw.stats.commits} aborts=${gw.stats.aborts} ` +
    `bad_crc=${gw.stats.badCrc} conflicts=${gw.stats.conflicts} exit=${exitCode}`);
  process.exitCode = exitCode;
}

main();
