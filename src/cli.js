#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Planner } from './planner.js';

export function runCli(input) {
  const planner = new Planner();
  const lines = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      lines.push(JSON.stringify({ status: 'INVALID_INPUT', error: 'malformed JSON' }));
      continue;
    }
    lines.push(JSON.stringify(planner.execute(cmd)));
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const input = process.argv[2] !== undefined
    ? readFileSync(process.argv[2], 'utf8')
    : readFileSync(0, 'utf8');
  process.stdout.write(runCli(input));
}
