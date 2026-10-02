#!/usr/bin/env node
'use strict';

// Usage:
//   node cli.js <mode-events.jsonl> [outDir]   consume events, write
//                                              transition.jsonl + violations.jsonl
//   node cli.js --counterexample [depth]       search minimal event prefix that
//                                              leads to an illegal auto start
//
// Exit codes: 0 ok, 2 usage/IO/parse error, 13 unknown mode,
//             14 non-monotonic clock, 15 door sensor contradiction.

const fs = require('fs');
const path = require('path');
const { Interpreter, ExitError } = require('./src/interpreter');
const { findIllegalAutoStart } = require('./src/counterexample');

function parseJsonl(text) {
  const events = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new ExitError(2, `line ${idx + 1}: invalid JSON`);
    }
  });
  return events;
}

function writeOutputs(outDir, interp) {
  const transitions = interp.transitions.map((t) => JSON.stringify(t)).join('\n');
  const violations = interp.violations.map((v) => JSON.stringify(v)).join('\n');
  fs.writeFileSync(path.join(outDir, 'transition.jsonl'), transitions ? transitions + '\n' : '');
  fs.writeFileSync(path.join(outDir, 'violations.jsonl'), violations ? violations + '\n' : '');
}

function runFile(input, outDir) {
  const events = parseJsonl(fs.readFileSync(input, 'utf8'));
  const interp = new Interpreter();
  try {
    interp.run(events);
  } finally {
    writeOutputs(outDir, interp);
  }
  const s = interp.snapshot();
  console.log(`processed ${events.length} events: ${interp.transitions.length} transitions, ${interp.violations.length} violations/discards`);
  console.log(`final: mode=${s.mode} door=${s.door} curtain=${s.curtain} running=${s.running} speedLimit=${s.speedLimit} keys=${s.keys.map((k) => `${k.key}@${k.level}`).join(',') || 'none'}`);
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] === '--counterexample') {
    const depth = args[1] !== undefined ? Number(args[1]) : 8;
    if (!Number.isInteger(depth) || depth < 1) {
      throw new ExitError(2, 'counterexample depth must be a positive integer');
    }
    const res = findIllegalAutoStart({ maxDepth: depth });
    if (res.found) {
      console.log('minimal event prefix leading to illegal automatic start:');
      console.log(JSON.stringify(res.prefix, null, 2));
      return 1;
    }
    console.log(`no illegal automatic start up to depth ${res.maxDepth} (checked ${res.checked} sequences)`);
    return 0;
  }
  const input = args[0] || 'mode-events.jsonl';
  const outDir = args[1] || '.';
  return runFile(input, outDir);
}

try {
  process.exitCode = main(process.argv);
} catch (err) {
  if (err instanceof ExitError) {
    fs.writeSync(2, `error: ${err.message}\n`);
    process.exitCode = err.code;
  } else if (err && err.code === 'ENOENT') {
    fs.writeSync(2, `error: ${err.message}\n`);
    process.exitCode = 2;
  } else {
    throw err;
  }
}
