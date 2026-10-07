#!/usr/bin/env node
import readline from 'node:readline';
import { createCli } from './cli-core.js';

const cli = createCli();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  process.stdout.write(JSON.stringify(cli.processLine(trimmed)) + '\n');
}
