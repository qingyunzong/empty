#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine } = require('./engine');

// Runs newline-delimited JSON commands through a fresh engine and returns one
// result object per input line plus whether any line errored.
function runCommands(input) {
  const engine = new Engine();
  const results = [];
  let hadError = false;
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch (err) {
      hadError = true;
      results.push({ type: 'error', code: 'INVALID_JSON', message: err.message });
      continue;
    }
    const result = engine.safeExecute(cmd);
    if (result.type === 'error') hadError = true;
    results.push(result);
  }
  return { results, hadError };
}

// Reads commands from a file argument or stdin, writes one JSON line per
// command to stdout. Exit code is 1 if any command produced an error.
function main() {
  const file = process.argv[2];
  const input = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const { results, hadError } = runCommands(input);
  for (const result of results) {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  process.exitCode = hadError ? 1 : 0;
}

if (require.main === module) {
  main();
}

module.exports = { runCommands };
