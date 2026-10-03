#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimulation } from './src/sim.js';

const USAGE = 'usage: node cli.js sim --in <dir> --out <dir>';

export function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'sim') {
    console.error(USAGE);
    return 1;
  }
  let inDir = null;
  let outDir = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--in') inDir = rest[++i];
    else if (rest[i] === '--out') outDir = rest[++i];
    else {
      console.error(USAGE);
      return 1;
    }
  }
  if (!inDir || !outDir) {
    console.error(USAGE);
    return 1;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(join(inDir, 'tasks.json'), 'utf8'));
  } catch (err) {
    console.error(`cannot read tasks.json: ${err.message}`);
    return 1;
  }

  let lines;
  try {
    lines = readFileSync(join(inDir, 'events.jsonl'), 'utf8').split('\n');
  } catch (err) {
    console.error(`cannot read events.jsonl: ${err.message}`);
    return 1;
  }

  const events = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      events.push({ type: '__parse_error__', line: index + 1, raw: trimmed });
    }
  });

  const { finalSlots, ledger, errors } = runSimulation(config, events);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'final_slots.json'), `${JSON.stringify(finalSlots, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'ledger.jsonl'),
    ledger.map((entry) => JSON.stringify(entry)).join('\n') + (ledger.length > 0 ? '\n' : ''),
  );
  if (errors.length > 0) {
    writeFileSync(join(outDir, 'errors.jsonl'), errors.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }

  const states = finalSlots.tasks;
  const summary = Object.values(states).reduce((acc, state) => {
    acc[state] = (acc[state] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `events=${ledger.length} tasks=${JSON.stringify(summary)} errors=${errors.length}`,
  );
  return errors.length > 0 ? 2 : 0;
}

const invokedAs = process.argv[1] ? realpathSync(process.argv[1]) : null;
if (invokedAs === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
