#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { Gateway, StructureError, ConflictError } = require('./lib/gateway');

function parseArgs(argv) {
  const args = { log: 'frames.log', timeout: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--stream') args.stream = argv[++i];
    else if (k === '--out') args.out = argv[++i];
    else if (k === '--log') args.log = argv[++i];
    else if (k === '--timeout') args.timeout = Number(argv[++i]);
    else { console.error(`unknown arg: ${k}`); process.exit(64); }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.stream || !args.out) {
    console.error('usage: node cli.js --stream s.bin --out certs.json [--log frames.log] [--timeout ms]');
    process.exit(64);
  }
  // Restart-safe: previously finalized certs are preserved and their
  // sessions remain the conflict baseline for this board.
  let certs = [];
  if (fs.existsSync(args.out)) {
    try { certs = JSON.parse(fs.readFileSync(args.out, 'utf8')); } catch { certs = []; }
  }
  const gw = new Gateway({ certs, timeoutMs: args.timeout });
  let exitCode = 0;
  try {
    gw.feed(fs.readFileSync(args.stream));
    gw.checkTimeouts();
  } catch (err) {
    if (err instanceof StructureError) { gw.log(`structure_error ${err.message}`); exitCode = 2; }
    else if (err instanceof ConflictError) { gw.log(`conflict ${err.message}`); exitCode = 6; }
    else throw err;
  } finally {
    if (gw.events.length) fs.appendFileSync(args.log, gw.events.join('\n') + '\n');
    fs.writeFileSync(args.out, JSON.stringify(gw.certs, null, 2) + '\n');
  }
  process.exitCode = exitCode;
}

main();
