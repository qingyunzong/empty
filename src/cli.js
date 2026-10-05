#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { FluxEngine } from './engine.js';

function usage() {
  console.error('usage: node src/cli.js flux --in <events.jsonl>  (use "-" for stdin)');
  process.exitCode = 2;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command !== 'flux') {
    usage();
    return;
  }
  const inIndex = args.indexOf('--in');
  const input = inIndex >= 0 ? args[inIndex + 1] : null;
  if (!input) {
    usage();
    return;
  }

  const engine = new FluxEngine();
  const stream = input === '-' ? process.stdin : createReadStream(input, 'utf8');
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    for (const output of engine.ingestLine(line)) {
      console.log(JSON.stringify(output));
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
