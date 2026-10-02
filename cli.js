#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { parseFrames } = require('./src/events');
const { ChainBuilder } = require('./src/chain');

function stderrLine(msg) {
  fs.writeSync(2, msg + '\n');
}

function usage() {
  stderrLine('usage: node cli.js <events.jsonl> [--cert <out.json>] [--timeout <ms>]');
  process.exit(2);
}

function main(argv) {
  const args = [...argv];
  let input = null;
  let certPath = null;
  let timeout = 30000;
  while (args.length) {
    const a = args.shift();
    if (a === '--cert') certPath = args.shift();
    else if (a === '--timeout') timeout = Number(args.shift());
    else if (a.startsWith('--cert=')) certPath = a.slice(7);
    else if (a.startsWith('--timeout=')) timeout = Number(a.slice(10));
    else if (a.startsWith('--')) usage();
    else if (input === null) input = a;
    else usage();
  }
  if (!input || !Number.isFinite(timeout) || timeout < 0) usage();

  let text;
  try {
    text = fs.readFileSync(input, 'utf8');
  } catch (err) {
    stderrLine('error: cannot read ' + input + ': ' + err.message);
    process.exit(1);
  }

  const builder = new ChainBuilder({ timeout });
  try {
    builder.ingestAll(parseFrames(text));
    const cert = builder.certificate();
    const out = JSON.stringify(cert, null, 2) + '\n';
    if (certPath) fs.writeFileSync(certPath, out);
    else fs.writeSync(1, out);
    stderrLine(
      `ok: ${cert.eventCount} events, ${cert.jobCount} jobs, ${cert.legCount} legs, ` +
      `${cert.rootCauses.length} root cause(s), ${cert.staleLog.length} stale record(s), ` +
      `hash ${cert.chainHash.slice(0, 16)}...`);
  } catch (err) {
    if (err && err.exitCode) {
      stderrLine(`error[${err.code}]: ${err.message}`);
      process.exit(err.exitCode);
    }
    stderrLine('error: ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
}

main(process.argv.slice(2));
