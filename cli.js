#!/usr/bin/env node
'use strict';

// Reads a JSON op script from stdin and prints per-op diff + certificate
// plus the final snapshot as JSON on stdout.
//
// Input:  { "ops": [ { "op": "addPlate", "plate": "P1" }, ... ] }
//         (a bare array of ops is also accepted)
// Output: { "results": [...], "final": { hash, invalid, errors, nodes } }

const { runCli } = require('./src/cli-core');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const { status, output } = runCli(raw);
  const pretty = status === 0 ? JSON.stringify(output, null, 2) : JSON.stringify(output);
  process.stdout.write(pretty + '\n');
  process.exitCode = status;
});
