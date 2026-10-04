#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { QError } from './errors.js';

export function parseInput(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  try {
    const value = JSON.parse(trimmed);
    return Array.isArray(value) ? value : [value];
  } catch {
    return trimmed.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => JSON.parse(l));
  }
}

export function runLines(commands) {
  const store = new Store();
  const outputs = [];
  let failed = false;
  for (const cmd of commands) {
    let out;
    try {
      out = store.apply(cmd);
    } catch (err) {
      failed = true;
      out = err instanceof QError
        ? { ok: false, error: { code: err.code, message: err.message } }
        : { ok: false, error: { code: 'INTERNAL', message: String(err?.message ?? err) } };
    }
    outputs.push(out);
  }
  return { outputs, failed };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const file = process.argv[2];
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const { outputs, failed } = runLines(parseInput(text));
  for (const out of outputs) process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = failed ? 1 : 0;
}
