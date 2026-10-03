#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { createSession } from './src/session.js';

const session = createSession();

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const result = session.handleLine(line);
  if (result !== null) process.stdout.write(`${JSON.stringify(result)}\n`);
});
