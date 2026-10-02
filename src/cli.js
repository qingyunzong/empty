#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { initState, applyTransaction } from './engine.js';

// Request (JSON on stdin):
// {
//   "tasks": { "id": { "input": "...", "version": "...", "deps": ["..."] } },
//   "transaction": { "setInput"?, "setVersion"?, "addDeps"?, "removeDeps"? },
//   "maxRecompute": 10
// }
// Response (JSON on stdout): init error, or transaction result.
let request;
try {
  request = JSON.parse(readFileSync(0, 'utf8'));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'E_BAD_REQUEST', message: String(err) }) + '\n');
  process.exit(0);
}

const init = initState(request.tasks ?? {});
if (!init.ok) {
  process.stdout.write(JSON.stringify(init) + '\n');
  process.exit(0);
}

const result = applyTransaction(init.state, request.transaction ?? {}, {
  maxRecompute: request.maxRecompute,
});
process.stdout.write(JSON.stringify(result) + '\n');
