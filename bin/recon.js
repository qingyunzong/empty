#!/usr/bin/env node
'use strict';
// recon - incremental reconciliation diff-cluster CLI.
//
//   node bin/recon.js run <input.jsonl|-> [--state DIR]   apply events, emit JSONL
//   node bin/recon.js verify [--state DIR]                recompute and check certificate
//
// Input JSONL events:
//   {"type":"internal","id":"I1","amount":100.00,"date":"2026-01-10"}
//   {"type":"external","id":"E1","amount":100.00,"date":"2026-01-10"}
//   {"type":"cancel","id":"E1"}
//   {"type":"rule","version":"v2"}
// Output JSONL: {"kind":"cluster",...} {"kind":"suggestion",...} {"kind":"certificate",...}
// All errors go to stderr with exit code 9.

const fs = require('node:fs');
const { runCli, SimulatedCrash } = require('../src/cli');

try {
  const code = runCli(process.argv.slice(2), {
    readStdin: () => fs.readFileSync(0, 'utf8'),
    writeOut: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    env: process.env,
  });
  process.exit(code);
} catch (err) {
  if (err instanceof SimulatedCrash) process.exit(2);
  throw err;
}
