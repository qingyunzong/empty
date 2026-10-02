#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { schedule } from '../src/scheduler.js';
import { ExitError } from '../src/errors.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['map', 'tasks', 'grants']) {
    if (!args[required]) throw new Error(`missing --${required} <path>`);
  }
  const map = JSON.parse(readFileSync(args.map, 'utf8'));
  const tasks = readJsonl(args.tasks);
  const grants = readJsonl(args.grants);
  const { plan, deny } = schedule({ map, tasks, grants });
  writeJsonl(args.plan ?? 'plan.jsonl', plan);
  writeJsonl(args.deny ?? 'deny.jsonl', deny);
  console.error(`planned=${plan.length} denied=${deny.length}`);
}

try {
  main();
} catch (error) {
  if (error instanceof ExitError) {
    console.error(`error(exit ${error.code}): ${error.message}`);
    process.exit(error.code);
  }
  console.error(`fatal: ${error.message}`);
  process.exit(1);
}
