#!/usr/bin/env node
// JSONL CLI: reads one command object per line from a file argument or stdin,
// writes one JSON result object per line to stdout.
import { readFileSync } from 'node:fs';
import { processJsonl } from './src/cli-core.js';

const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
for (const result of processJsonl(input)) {
  process.stdout.write(JSON.stringify(result) + '\n');
}
