#!/usr/bin/env node
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadMap } from './src/map.js';
import { schedule } from './src/scheduler.js';
import { ExitError } from './src/errors.js';

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new ExitError(2, `${path}:${i + 1} invalid JSON`);
      }
    });
}

function writeJsonl(path, records) {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

function main() {
  const { values } = parseArgs({
    options: {
      map: { type: 'string' },
      tasks: { type: 'string' },
      grants: { type: 'string' },
      plan: { type: 'string', default: 'plan.jsonl' },
      deny: { type: 'string', default: 'deny.jsonl' },
    },
  });
  for (const key of ['map', 'tasks', 'grants']) {
    if (!values[key]) throw new ExitError(2, `missing required --${key}`);
  }
  const map = loadMap(values.map);
  const tasks = readJsonl(values.tasks);
  const grants = readJsonl(values.grants);
  const { plan, deny } = schedule(map, grants, tasks);
  writeJsonl(values.plan, plan);
  writeJsonl(values.deny, deny);
  writeSync(1, `planned=${plan.length} denied=${deny.length} -> ${values.plan}, ${values.deny}\n`);
}

try {
  main();
} catch (err) {
  if (err instanceof ExitError) {
    writeSync(2, `error(exit ${err.code}): ${err.message}\n`);
    process.exitCode = err.code;
  } else {
    writeSync(2, `${err?.stack ?? err}\n`);
    process.exitCode = 1;
  }
}
