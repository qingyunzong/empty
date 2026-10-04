#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { Planner, InvalidInput } = require('./src/planner');

function handleCommand(planner, cmd) {
  try {
    switch (cmd && cmd.op) {
      case 'add_task':
        planner.addTask(cmd.id, cmd.dur, cmd.cost);
        return { status: 'OK' };
      case 'dep':
        planner.dep(cmd.a, cmd.b);
        return { status: 'OK' };
      case 'group_begin':
        planner.groupBegin();
        return { status: 'OK' };
      case 'group_end':
        planner.groupEnd();
        return { status: 'OK' };
      case 'commit':
        planner.commit();
        return { status: 'OK' };
      case 'rollback':
        return planner.rollback(cmd.level) === 'OK' ? { status: 'OK' } : { status: 'ROLLBACK_RANGE' };
      case 'schedule':
        return planner.schedule(cmd.budget);
      default:
        return { status: 'INVALID_INPUT', error: `unknown op: ${cmd && cmd.op}` };
    }
  } catch (err) {
    if (err instanceof InvalidInput) return { status: 'INVALID_INPUT', error: err.message };
    throw err;
  }
}

function runLines(lines) {
  const planner = new Planner();
  const results = [];
  for (const line of lines) {
    const trimmed = String(line).trim();
    if (!trimmed) continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      results.push({ status: 'INVALID_INPUT', error: 'malformed JSON line' });
      continue;
    }
    results.push(handleCommand(planner, cmd));
  }
  return results;
}

async function main() {
  const fileArg = process.argv[2];
  const input = fileArg ? fs.createReadStream(fileArg, 'utf8') : process.stdin;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const planner = new Planner();
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      out({ status: 'INVALID_INPUT', error: 'malformed JSON line' });
      continue;
    }
    out(handleCommand(planner, cmd));
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  });
}

module.exports = { runLines, handleCommand };
