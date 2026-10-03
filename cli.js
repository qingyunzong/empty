#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Engine } from './src/engine.js';

// Processes JSONL text (one JSON command per line) and returns the output
// records plus whether any error occurred. Blank lines and lines starting
// with '#' are ignored.
export function processText(text) {
  const engine = new Engine();
  const records = [];
  let hadError = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      hadError = true;
      records.push({ type: 'error', error: 'BAD_JSON', line: trimmed });
      continue;
    }
    for (const record of engine.execute(cmd)) {
      if (record.type === 'error') hadError = true;
      records.push(record);
    }
  }
  return { records, hadError };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Reads JSON commands from stdin, writes JSON output records (one per
  // line) to stdout. Exit code is 1 if any command produced an error.
  let input = '';
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) input += line + '\n';
  const { records, hadError } = processText(input);
  for (const record of records) process.stdout.write(JSON.stringify(record) + '\n');
  process.exitCode = hadError ? 1 : 0;
}
