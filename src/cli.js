#!/usr/bin/env node
// Offline CLI:
//   node src/cli.js maintenance input.json commands.json -o out.json
//
// Exit codes: 0 = ok (steps may still be infeasible/noop; that is data),
//             1 = input/validation error, 2 = usage/IO error.

import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { ProblemError } from './model.js';
import { runCommandStream } from './scheduler.js';

function usage() {
  return [
    'usage: node src/cli.js maintenance <input.json> <commands.json> [-o out.json]',
    '',
    'input.json:    { "budget": int>=0, "crews"?: 2, "parts"?: {id: qty},',
    '               "tasks": [{ "id", "deps"?: [], "modes": [{duration, cost, parts?}] }] }',
    'commands.json: [ {op:"addTask", task}, {op:"removeTask", id},',
    '               {op:"updateMode", task, mode, patch:{duration?,cost?,parts?}},',
    '               {op:"repriceMode", task, mode, cost},',
    '               {op:"setBudget", budget}, {op:"undo"}, {op:"redo"} ]',
  ].join('\n');
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const e = new Error(`cannot read ${path}: ${err.message}`);
    e.exitCode = 2;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`invalid JSON in ${path}: ${err.message}`);
    e.exitCode = 2;
    throw e;
  }
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] !== 'maintenance') {
    const e = new Error(`unknown subcommand "${args[0] ?? ''}"\n${usage()}`);
    e.exitCode = 2;
    throw e;
  }
  const positional = [];
  let out = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '-o') {
      out = args[++i];
      if (!out) {
        const e = new Error(`missing value for -o\n${usage()}`);
        e.exitCode = 2;
        throw e;
      }
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 2) {
    const e = new Error(`expected input.json and commands.json\n${usage()}`);
    e.exitCode = 2;
    throw e;
  }
  return { inputPath: positional[0], commandsPath: positional[1], outPath: out };
}

function summarizeStep(step) {
  const label = step.command ? step.command.op : 'initial';
  if (step.status === 'optimal') {
    const s = step.schedule;
    return `step ${step.index} [${label}] optimal downtime=${s.downtime} cost=${s.cost} sequence=${s.sequence.join(',')}`;
  }
  if (step.status === 'infeasible') {
    const why = (step.violations || []).map((v) => v.code).join('+') || 'infeasible';
    return `step ${step.index} [${label}] infeasible (${why})`;
  }
  if (step.status === 'error') {
    return `step ${step.index} [${label}] error ${step.error.code}: ${step.error.message}`;
  }
  return `step ${step.index} [${label}] ${step.status}${step.reason ? ` (${step.reason})` : ''}`;
}

function main(argv) {
  const { inputPath, commandsPath, outPath } = parseArgs(argv);
  const input = readJson(inputPath);
  const rawCommands = readJson(commandsPath);
  const commands = Array.isArray(rawCommands) ? rawCommands : rawCommands.commands;
  if (!Array.isArray(commands)) {
    const e = new Error('commands.json must be an array or an object with a "commands" array');
    e.exitCode = 2;
    throw e;
  }

  let steps;
  try {
    ({ steps } = runCommandStream(input, commands));
  } catch (err) {
    if (err instanceof ProblemError) {
      const e = new Error(JSON.stringify({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }));
      e.exitCode = 1;
      throw e;
    }
    throw err;
  }

  const output = {
    problem: 'maintenance',
    version: 1,
    objectiveOrder: ['totalDowntime', 'totalCost', 'taskSequence'],
    steps,
    final: steps[steps.length - 1],
  };
  const json = JSON.stringify(output, null, 2);
  if (outPath) {
    writeFileSync(outPath, json + '\n');
  }
  // Synchronous writes: piped stdout must not lose buffered output.
  const out = (line) => {
    try {
      writeSync(1, line + '\n');
    } catch (err) {
      if (err && err.code === 'EPIPE') process.exit(0);
      throw err;
    }
  };
  for (const step of steps) out(summarizeStep(step));
  out(outPath ? `wrote ${outPath}` : json);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  writeSync(2, String(err.message || err) + '\n');
  process.exitCode = err.exitCode || 1;
}
