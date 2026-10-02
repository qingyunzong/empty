#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine } from './engine.js';
import { EngineError } from './errors.js';

const USAGE = [
  'Usage: node src/cli.js alarms <events.json> <rules.json> [-o out.json]',
  '',
  '  events.json  JSON array of commands: append | retract | addRule | removeRule | undo',
  '  rules.json   JSON array of initial rules',
  '  -o, --output Output file for the resulting state (defaults to stdout)',
  '',
].join('\n');

function exitWith(code, message, details, exitCode) {
  const payload = { error: { code, message, ...(details ? { details } : {}) } };
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(exitCode);
}

function usageError(message) {
  process.stderr.write((message ? message + '\n' : '') + USAGE);
  process.exit(2);
}

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    exitWith('READ_ERROR', `cannot read ${label} file "${path}"`, { path }, 1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    exitWith('INVALID_JSON', `invalid JSON in ${label} file "${path}": ${err.message}`, { path }, 1);
  }
}

function main(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(subcommand === undefined ? 2 : 0);
  }
  if (subcommand !== 'alarms') {
    usageError(`unknown subcommand "${subcommand}"`);
  }

  let output = null;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '-o' || arg === '--output') {
      output = rest[++i];
      if (output === undefined) usageError(`missing value for ${arg}`);
    } else if (arg.startsWith('-')) {
      usageError(`unknown option "${arg}"`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    usageError('expected exactly two positional arguments: <events.json> <rules.json>');
  }

  const [eventsPath, rulesPath] = positional;
  const initialRules = readJson(rulesPath, 'rules');
  const commands = readJson(eventsPath, 'events');
  if (!Array.isArray(initialRules)) {
    exitWith('INVALID_INPUT', 'rules.json must contain a JSON array of rules', { path: rulesPath }, 1);
  }
  if (!Array.isArray(commands)) {
    exitWith('INVALID_INPUT', 'events.json must contain a JSON array of commands', { path: eventsPath }, 1);
  }

  try {
    const engine = new Engine({ rules: initialRules });
    let state = engine.getState();
    for (const command of commands) {
      state = engine.run(command);
    }
    const out = JSON.stringify(state, null, 2) + '\n';
    if (output) {
      writeFileSync(output, out);
    } else {
      process.stdout.write(out);
    }
  } catch (err) {
    if (err instanceof EngineError) {
      exitWith(err.code, err.message, err.details, 1);
    }
    throw err;
  }
}

main(process.argv.slice(2));
