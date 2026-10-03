#!/usr/bin/env node
// CLI: schedule | apply | undo | redo
//
//   node src/cli.js schedule --file workshop.json [--state file]
//   node src/cli.js apply --op '{"op":"upsertTask","task":{...}}' [--state file]
//   node src/cli.js undo [--state file]
//   node src/cli.js redo  [--state file]
//
// With --state, the workshop plus the full undo/redo log persist across
// invocations. Output is JSON on stdout; exit code 0 on success, 1 on error.

import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from './engine.js';
import { ModelError } from './model.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (err) {
    throw new ModelError(`invalid JSON in ${label}: ${err.message}`);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const statePath = typeof args.state === 'string' ? args.state : null;

  let engine = null;
  if (statePath) {
    try {
      engine = Engine.fromJSON(readJson(readFileSync(statePath, 'utf8'), statePath));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  let output;
  switch (command) {
    case 'schedule': {
      if (!engine) {
        if (!args.file) throw new ModelError('schedule requires --file <workshop.json> (or --state with saved data)');
        engine = new Engine(readJson(readFileSync(args.file, 'utf8'), args.file));
      }
      output = engine.schedule();
      break;
    }
    case 'apply': {
      if (!engine) {
        const base = args.file ? readJson(readFileSync(args.file, 'utf8'), args.file) : {};
        engine = new Engine(base);
      }
      if (!args.op) throw new ModelError('apply requires --op <json>');
      output = engine.apply(readJson(args.op, '--op'));
      break;
    }
    case 'undo': {
      if (!engine) throw new ModelError('undo requires --state <file> with saved history');
      output = engine.undo();
      break;
    }
    case 'redo': {
      if (!engine) throw new ModelError('redo requires --state <file> with saved history');
      output = engine.redo();
      break;
    }
    default:
      throw new ModelError(`unknown command ${JSON.stringify(command)}; expected schedule|apply|undo|redo`);
  }

  if (statePath) {
    writeFileSync(statePath, `${JSON.stringify(engine.toJSON(), null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  const message = err instanceof ModelError ? err.message : `internal error: ${err.stack ?? err}`;
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
