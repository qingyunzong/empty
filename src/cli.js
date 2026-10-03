#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { applyEvents, query, listPaths, StoreError } from './store.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fail') {
      args.fail = argv[i + 1];
      i += 1;
    } else if (arg === '--data') {
      args.data = argv[i + 1];
      i += 1;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

// Runs one CLI command and returns { code, stdout } so it can be driven
// both from the executable wrapper and from in-process tests.
export function runCommand(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const dataDir = args.data ?? process.env.MRP_DATA ?? './mrp-data';
  let result;
  if (command === 'apply') {
    const file = args._[0];
    if (!file) {
      throw new StoreError('usage: apply <events.json> [--fail before_append|after_append] [--data DIR]');
    }
    if (args.fail !== undefined && !['before_append', 'after_append'].includes(args.fail)) {
      throw new StoreError(`unknown fail point: ${args.fail}`);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const events = Array.isArray(parsed) ? parsed : parsed.events;
    const { version, applied } = applyEvents(dataDir, events, { fail: args.fail ?? null });
    result = { ok: true, version, applied };
  } else if (command === 'query') {
    result = query(dataDir);
  } else if (command === 'paths') {
    result = listPaths(dataDir);
  } else {
    throw new StoreError(`unknown command: ${command ?? '(none)'} (expected apply|query|paths)`);
  }
  return { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
}

export function runCli(argv) {
  try {
    return runCommand(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 1, stdout: `${JSON.stringify({ error: message })}\n` };
  }
}

const invokedAs = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedAs) {
  const { code, stdout } = runCli(process.argv.slice(2));
  process.stdout.write(stdout);
  if (code !== 0) process.exit(code);
}
