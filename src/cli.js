#!/usr/bin/env node
import { runCommands } from './cli-core.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const text = await readStdin();
for (const res of runCommands(text)) {
  process.stdout.write(JSON.stringify(res) + '\n');
}
