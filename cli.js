#!/usr/bin/env node
import { handleRequest } from './src/cli-core.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: { code: 'E_PARSE', message: `invalid JSON: ${e.message}` } }) + '\n'
  );
  process.exit(1);
}

process.stdout.write(JSON.stringify(handleRequest(input), null, 2) + '\n');
