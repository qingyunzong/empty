#!/usr/bin/env node
'use strict';

// Reads a JSON document from stdin: { "ops": [ <op>, ... ] } (a bare array is
// also accepted). Applies ops in order (including {"type":"undo"} /
// {"type":"redo"}) and writes { results: [certificate...], state } to stdout.

const { main } = require('./src/cli-main');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const { status, out, err } = main(input);
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(status);
});
