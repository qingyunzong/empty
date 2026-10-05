#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';

const USAGE = 'usage: node src/cli.js flux --in <events.jsonl>';

export function run(argv, { stdout = console.log, stderr = console.error } = {}) {
  const [command, ...rest] = argv;
  if (command !== 'flux') {
    stderr(USAGE);
    return 2;
  }
  let inputPath = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--in') {
      inputPath = rest[i + 1];
      i += 1;
    } else if (arg.startsWith('--in=')) {
      inputPath = arg.slice('--in='.length);
    } else {
      stderr(`unknown argument: ${arg}`);
      stderr(USAGE);
      return 2;
    }
  }
  if (!inputPath) {
    stderr(USAGE);
    return 2;
  }

  let text;
  try {
    text = inputPath === '-' ? readFileSync(0, 'utf8') : readFileSync(inputPath, 'utf8');
  } catch (error) {
    stderr(`cannot read input: ${error.message}`);
    return 1;
  }

  const engine = new Engine();
  const emit = (output) => stdout(JSON.stringify(output));

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      emit({ type: 'ERROR', code: 'MALFORMED', message: 'invalid JSON', line: index + 1 });
      return;
    }
    for (const output of engine.ingest(parsed)) emit(output);
  });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
