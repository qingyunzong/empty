#!/usr/bin/env node
'use strict';

// Usage: node cli.js exec <ops.jsonl> [--budget day=1000]
//
// Reads ops as JSONL (one JSON object per line), applies them through the
// engine, and writes one JSON result per line to stdout: the input op, status,
// error (if any), the state after the step, the undoPlan (for undo steps) and
// the undo stack depth.

const fs = require('fs');
const { Engine } = require('./src/engine');

function parseBudget(spec) {
  const budget = {};
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (key !== 'day' || !Number.isFinite(value) || value < 0) return null;
    budget[key] = value;
  }
  return budget;
}

// Returns a process exit code. `log` receives one JSON line per processed op;
// `error` receives diagnostics.
function run(argv, io = {}) {
  const log = io.log || ((line) => console.log(line));
  const error = io.error || ((line) => console.error(line));
  const usage = () => {
    error('usage: node cli.js exec <ops.jsonl> [--budget day=1000]');
    return 1;
  };
  const [cmd, file, ...rest] = argv;
  if (cmd !== 'exec' || !file) return usage();

  let budget = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--budget') {
      const spec = rest[++i];
      if (spec === undefined) return usage();
      budget = parseBudget(spec);
      if (!budget) {
        error('invalid --budget spec (expected e.g. day=1000): ' + spec);
        return 1;
      }
    } else {
      return usage();
    }
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    error('cannot read ' + file + ': ' + err.message);
    return 1;
  }

  const engine = new Engine(budget ? { budget } : {});
  let step = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    step++;
    let input;
    try {
      input = JSON.parse(line);
    } catch (err) {
      log(
        JSON.stringify({
          step,
          input: null,
          status: 'error',
          error: { code: 'INVALID', message: 'invalid JSON: ' + err.message },
          undoPlan: null,
          state: engine.snapshotState(),
          undoDepth: engine.stack.length,
        })
      );
      continue;
    }
    const result = engine.apply(input);
    log(JSON.stringify({ step, ...result }));
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
