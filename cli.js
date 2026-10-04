#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { checkFlow } = require('./src/audit');
const { equivFlows } = require('./src/equiv');
const { FlowError } = require('./src/regex');

function readLog(path) {
  const text = fs.readFileSync(path, 'utf8');
  const events = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let v;
    try { v = JSON.parse(trimmed); } catch { throw new FlowError('BAD_LOG', `line ${i + 1}: invalid JSON`); }
    if (typeof v === 'string') events.push(v);
    else if (v && typeof v === 'object' && typeof v.event === 'string') events.push(v.event);
    else throw new FlowError('BAD_LOG', `line ${i + 1}: expected JSON string or {"event": ...}`);
  }
  return events;
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'check') {
    const [flowPath, logPath, ...rest] = args;
    let k = 6;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--k') k = Number(rest[++i]);
    }
    const flow = fs.readFileSync(flowPath, 'utf8');
    const events = readLog(logPath);
    return checkFlow(flow, events, k);
  }
  if (cmd === 'equiv') {
    const [flowPath1, flowPath2] = args;
    return equivFlows(fs.readFileSync(flowPath1, 'utf8'), fs.readFileSync(flowPath2, 'utf8'));
  }
  throw new FlowError('USAGE', 'usage: node cli.js check flow.re log.jsonl [--k N] | node cli.js equiv a.re b.re');
}

function run(argv) {
  try {
    const out = main(argv);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    if (out.error) process.exitCode = 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.code || 'INTERNAL', message: e.message }) + '\n');
    process.exitCode = 2;
  }
}

if (require.main === module) run(process.argv.slice(2));

module.exports = { main, readLog };
