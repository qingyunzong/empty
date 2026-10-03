#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Gateway, InputError } from './src/engine.js';

const USAGE = 'usage: node cli.js <events.jsonl> [--patterns <patterns.json>]';

class UsageError extends Error {}

function parseArgs(argv) {
  const positional = [];
  let patternsPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--patterns') {
      i += 1;
      if (i >= argv.length) throw new UsageError('missing value for --patterns');
      patternsPath = argv[i];
    } else if (argv[i].startsWith('--')) {
      throw new UsageError(`unknown option: ${argv[i]}`);
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 1) throw new UsageError(USAGE);
  return { eventsPath: positional[0], patternsPath };
}

export function run(argv, io) {
  const { stdout, stderr, readFile = readFileSync } = io;
  const fail = (message, exitCode) => {
    stderr(`${JSON.stringify({ type: 'error', message })}\n`);
    return exitCode;
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) return fail(err.message, 2);
    throw err;
  }

  let patterns = [];
  if (args.patternsPath !== null) {
    let raw;
    try {
      raw = readFile(args.patternsPath, 'utf8');
    } catch (err) {
      return fail(`cannot read patterns file ${args.patternsPath}: ${err.message}`, 2);
    }
    try {
      patterns = JSON.parse(raw);
    } catch (err) {
      return fail(`invalid patterns JSON: ${err.message}`, 3);
    }
  }

  let gateway;
  try {
    gateway = new Gateway({ patterns });
  } catch (err) {
    if (err instanceof InputError) return fail(err.message, 3);
    throw err;
  }

  let eventsRaw;
  try {
    eventsRaw = readFile(args.eventsPath, 'utf8');
  } catch (err) {
    return fail(`cannot read events file ${args.eventsPath}: ${err.message}`, 2);
  }

  const lines = eventsRaw.split('\n');
  for (let lineno = 0; lineno < lines.length; lineno += 1) {
    const line = lines[lineno].trim();
    if (line === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (err) {
      return fail(`line ${lineno + 1}: invalid JSON: ${err.message}`, 3);
    }
    let outputs;
    try {
      outputs = gateway.apply(record);
    } catch (err) {
      if (err instanceof InputError) return fail(`line ${lineno + 1}: ${err.message}`, 3);
      throw err;
    }
    for (const output of outputs) {
      stdout(`${JSON.stringify(output)}\n`);
    }
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}
