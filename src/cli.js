#!/usr/bin/env node
import { runCli } from './cli-core.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const { text, code } = runCli(await readStdin());
process.stdout.write(text);
process.exitCode = code;
