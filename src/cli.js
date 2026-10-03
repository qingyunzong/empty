#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { MaintenanceStore } = require('./state');
const { ValidationError } = require('./model');

const USAGE = `Usage: node src/cli.js maintenance <input.json> <commands.json> -o <out.json>

  input.json     initial maintenance problem (budget, parts, tasks DAG with modes)
  commands.json  JSON array of commands: setBudget | addTask | removeTask |
                 updateModeCost | undo | redo
  -o <file>      write result JSON to file (default: stdout)

Exit codes: 0 ok, 1 usage/IO error, 2 validation or command error.`;

function fail(code, message, exitCode) {
  fs.writeSync(2, `error[${code}]: ${message}\n`);
  return exitCode;
}

function readJson(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw { code: 'IO_ERROR', message: `cannot read ${path}: ${err.message}`, exitCode: 1 };
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw { code: 'INVALID_JSON', message: `cannot parse ${path}: ${err.message}`, exitCode: 1 };
  }
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    fs.writeSync(1, `${USAGE}\n`);
    return args.length === 0 ? 1 : 0;
  }
  if (args[0] !== 'maintenance') {
    return fail('USAGE', `unknown subcommand "${args[0]}"\n${USAGE}`, 1);
  }
  const positional = [];
  let outPath = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '-o') {
      if (i + 1 >= args.length) return fail('USAGE', '-o requires a file path', 1);
      outPath = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 2) {
    return fail('USAGE', `expected input.json and commands.json\n${USAGE}`, 1);
  }

  let input; let commands;
  try {
    input = readJson(positional[0]);
    commands = readJson(positional[1]);
  } catch (err) {
    return fail(err.code, err.message, err.exitCode);
  }
  if (!Array.isArray(commands)) {
    return fail('INVALID_COMMANDS', 'commands.json must contain a JSON array of commands', 1);
  }

  let store;
  try {
    store = new MaintenanceStore(input);
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.code, err.message, 2);
    throw err;
  }

  const output = { initial: store.currentResult(), steps: [] };
  let exitCode = 0;
  for (let i = 0; i < commands.length; i += 1) {
    const cmd = commands[i];
    try {
      const step = store.applyCommand(cmd);
      output.steps.push({ index: i, command: cmd, status: 'ok', diff: step.diff, result: step.result });
    } catch (err) {
      if (err instanceof ValidationError) {
        output.steps.push({
          index: i,
          command: cmd,
          status: 'error',
          error: { code: err.code, message: err.message },
        });
        fs.writeSync(2, `error[${err.code}]: command ${i} (${cmd && cmd.type}): ${err.message}\n`);
        exitCode = 2;
        break;
      }
      throw err;
    }
  }
  output.final = store.currentResult();

  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (outPath) {
    try {
      fs.writeFileSync(outPath, text);
    } catch (err) {
      return fail('IO_ERROR', `cannot write ${outPath}: ${err.message}`, 1);
    }
  } else {
    fs.writeSync(1, text);
  }
  return exitCode;
}

process.exitCode = main(process.argv);
