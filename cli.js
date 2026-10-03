#!/usr/bin/env node
'use strict';
// Usage:
//   node cli.js apply  --state DIR   < events.jsonl   (apply events, persist, print reports)
//   node cli.js replay --state DIR                     (rebuild from log, verify index, print reports)
// Output: JSONL on stdout: deliverable / exposure / proof. Errors: stderr, exit code 7.

const fs = require('node:fs');
const { applyEvent, reports, EngineError } = require('./src/engine');
const persist = require('./src/persist');

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  let stateDir = './.fxstate';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--state' && rest[i + 1]) {
      stateDir = rest[i + 1];
      i++;
    } else {
      throw new EngineError('USAGE', `unknown argument ${rest[i]}`);
    }
  }
  if (cmd !== 'apply' && cmd !== 'replay') {
    throw new EngineError('USAGE', 'expected command: apply | replay');
  }
  return { cmd, stateDir };
}

// Invoable in-process (tests) and from the shell. Returns {code, stdout, stderr}.
function run(argv, stdin) {
  try {
    const { cmd, stateDir } = parseArgs(argv);
    const state = persist.loadState(stateDir);
    let stderr = '';

    if (cmd === 'apply') {
      const lines = String(stdin).split('\n').filter((l) => l.trim());
      const events = lines.map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          throw new EngineError('BAD_JSON', `line ${i + 1}: invalid JSON`);
        }
      });
      for (const ev of events) applyEvent(state, ev);
      persist.appendEvents(stateDir, events);
    }

    const check = persist.checkIndex(stateDir, state);
    if (!check.ok) stderr += `index ${check.reason}; rebuilding from event log\n`;
    persist.saveIndex(stateDir, state);

    const stdout = reports(state).map((r) => JSON.stringify(r) + '\n').join('');
    return { code: 0, stdout, stderr };
  } catch (err) {
    const code = err instanceof EngineError ? err.code : 'INTERNAL';
    return { code: 7, stdout: '', stderr: `ERROR ${code}: ${err.message}\n` };
  }
}

if (require.main === module) {
  const stdin = process.argv[2] === 'apply' ? fs.readFileSync(0, 'utf8') : '';
  const res = run(process.argv.slice(2), stdin);
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  process.exit(res.code);
}

module.exports = { run };
