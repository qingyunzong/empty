#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseEvents } = require('./src/parser');
const { Processor, CycleError, RetryError, ValidationError } = require('./src/processor');

function usage() {
  console.error('usage: node cli.js <events.jsonl> --cert <out.json> [--timeout-ms N]');
}

function main(argv) {
  const args = argv.slice(2);
  let input = null;
  let certPath = null;
  let timeoutMs = 30000;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cert') certPath = args[++i];
    else if (a === '--timeout-ms') timeoutMs = Number(args[++i]);
    else if (!a.startsWith('--') && input === null) input = a;
    else { usage(); return 2; }
  }
  if (!input || !certPath || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    usage();
    return 2;
  }

  let text;
  try {
    text = fs.readFileSync(input, 'utf8');
  } catch (err) {
    console.error(`error: cannot read ${input}: ${err.message}`);
    return 2;
  }

  let events;
  try {
    events = parseEvents(text);
  } catch (err) {
    console.error(`error: malformed event frame: ${err.message}`);
    return 2;
  }

  const proc = new Processor({ timeoutMs });
  try {
    for (const ev of events) proc.ingest(ev);
    const cert = proc.getCertificate();
    fs.writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');
    console.log(`events=${cert.eventCount} duplicates=${cert.duplicateCount} ` +
      `chainHash=${cert.chainHash.slice(0, 16)}… staleMarks=${cert.staleLog.length} ` +
      `rootCauses=${cert.rootCauses.length}`);
    console.log(`certificate written to ${certPath}`);
    return 0;
  } catch (err) {
    if (err instanceof CycleError) {
      console.error(`error: ${err.message}`);
      return 14;
    }
    if (err instanceof RetryError) {
      console.error(`error: ${err.message}`);
      return 15;
    }
    if (err instanceof ValidationError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

process.exitCode = main(process.argv);
