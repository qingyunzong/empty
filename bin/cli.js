#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { Engine, EngineError } = require('../src/engine');

const engine = new Engine();
let hadError = false;

const outStream = process.argv[3] ? fs.createWriteStream(process.argv[3]) : process.stdout;

function emit(obj) {
  outStream.write(JSON.stringify(obj) + '\n');
}

function dispatch(cmd) {
  switch (cmd.cmd) {
    case 'config':
      if (cmd.mergeGapMs !== undefined) engine.setMergeGap(cmd.mergeGapMs);
      return { type: 'ok', cmd: 'config' };
    case 'shifts':
      engine.setShiftTable(cmd.table);
      return { type: 'ok', cmd: 'shifts', segments: engine.shiftTable.length };
    case 'downtime':
      engine.setDowntime(cmd.intervals);
      return { type: 'ok', cmd: 'downtime', intervals: engine.downtime.length };
    case 'rule':
      engine.addRule(cmd);
      return { type: 'ok', cmd: 'rule', id: cmd.id };
    case 'event':
      return engine.applyEvent(cmd);
    case 'cutoff':
      engine.setCutoff(cmd.time);
      return { type: 'alarms', cutoffMs: engine.cutoffMs, alarms: engine.alarms() };
    case 'alarms':
      return { type: 'alarms', cutoffMs: engine.frontier(), alarms: engine.alarms() };
    default:
      throw new EngineError('BAD_COMMAND', `unknown command ${JSON.stringify(cmd.cmd)}`);
  }
}

async function main() {
  const input = process.argv[2]
    ? fs.createReadStream(process.argv[2], 'utf8')
    : process.stdin;
  const rl = readline.createInterface({ input, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const cmd = JSON.parse(trimmed);
      const out = dispatch(cmd);
      for (const item of Array.isArray(out) ? out : [out]) emit(item);
    } catch (err) {
      hadError = true;
      emit({ type: 'error', code: err.code || 'INTERNAL', message: String(err.message || err) });
    }
  }
  if (outStream !== process.stdout) {
    await new Promise((resolve, reject) => outStream.end((err) => (err ? reject(err) : resolve())));
  }
  if (hadError) process.exitCode = 1;
}

main();
