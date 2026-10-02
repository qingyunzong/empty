#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseInstance, UsageError } from './model.js';
import { solve, replaceOperation, DEFAULT_BUDGET } from './solver.js';

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

function parseIntStrict(value, name) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new CliError(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 10);
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read ${path}: ${err.message}`, 1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`invalid JSON in ${path}: ${err.message}`);
  }
}

function parseFlags(args, allowed) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (!allowed.has(a)) throw new CliError(`unknown flag ${a}`);
      const value = args[i + 1];
      if (value === undefined) throw new CliError(`flag ${a} requires a value`);
      flags[a] = value;
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function budgetFrom(flags) {
  if (flags['--budget'] === undefined) return DEFAULT_BUDGET;
  const b = parseIntStrict(flags['--budget'], '--budget');
  if (b < 1) throw new CliError('--budget must be a positive integer');
  return b;
}

function main(argv) {
  const [command, ...rest] = argv;

  if (command === 'schedule') {
    const { flags, positional } = parseFlags(rest, new Set(['--budget']));
    if (positional.length !== 1) {
      throw new CliError('usage: mps schedule <instance.json> [--budget N]');
    }
    const instance = parseInstance(readJson(positional[0]));
    return { code: 0, json: solve(instance, { budget: budgetFrom(flags) }) };
  }

  if (command === 'replace') {
    const { flags, positional } = parseFlags(rest, new Set(['--budget', '--op', '--with']));
    if (positional.length !== 1 || !flags['--op'] || !flags['--with']) {
      throw new CliError('usage: mps replace <instance.json> --op <id> --with <new-op.json> [--budget N]');
    }
    const budget = budgetFrom(flags);
    const instance = parseInstance(readJson(positional[0]));
    const newOpRaw = readJson(flags['--with']);
    const scheduled = solve(instance, { budget });
    if (scheduled.status !== 'optimal') {
      return {
        code: 1,
        json: scheduled,
        error: `cannot replace "${flags['--op']}": base instance is ${scheduled.status}`,
      };
    }
    return {
      code: 0,
      json: replaceOperation(instance, scheduled.assignments, flags['--op'], newOpRaw, { budget }),
    };
  }

  throw new CliError('usage: mps <schedule|replace> ...');
}

/**
 * Programmatic entry point: runs the CLI and returns the process exit code.
 * Exit code 2 signals usage errors (illegal integers, unknown tools, ...).
 */
export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => console.log(s));
  const stderr = io.stderr ?? ((s) => console.error(s));
  try {
    const { code, json, error } = main(argv);
    if (error) stderr(`error: ${error}`);
    if (json !== undefined) stdout(JSON.stringify(json, null, 2));
    return code;
  } catch (err) {
    if (err instanceof CliError || err instanceof UsageError) {
      stderr(`error: ${err.message}`);
      return err.code ?? 2;
    }
    throw err;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
