#!/usr/bin/env node
import fs from 'node:fs';
import { runCli } from '../src/cli.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const code = runCli({
  argv: process.argv.slice(2),
  stdin: Buffer.concat(chunks).toString('utf8'),
  writeOut: (s) => fs.writeSync(1, s),
  writeErr: (s) => fs.writeSync(2, s),
});
process.exit(code);
