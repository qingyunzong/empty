#!/usr/bin/env node
// JSONL in (stdin or file arg) -> JSONL diff+proof out. Errors -> stderr, exit 10.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from './src/store.js';

// Pure-ish entry: returns { code, stdout, stderr } so tests can run in-process.
export function run(args, inputText) {
  let dir = '.settle-data';
  let inputFile = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--data') { dir = args[++i]; }
    else inputFile = args[i];
  }
  const text = inputFile != null ? fs.readFileSync(inputFile, 'utf8') : inputText;
  let stdout = '';
  let stderr = '';
  const store = new Store(dir);
  if (store.recovered) {
    stderr += JSON.stringify({ warning: 'RECOVERED_QUEUE', message: 'queue cache torn or stale; state rebuilt from event log' }) + '\n';
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let op;
    try {
      op = JSON.parse(line);
    } catch (e) {
      stderr += JSON.stringify({ error: 'BAD_JSON', message: e.message }) + '\n';
      return { code: 10, stdout, stderr };
    }
    try {
      stdout += JSON.stringify(store.apply(op)) + '\n';
    } catch (e) {
      stderr += JSON.stringify({ error: e.code || 'INTERNAL', message: e.message }) + '\n';
      return { code: 10, stdout, stderr };
    }
  }
  return { code: 0, stdout, stderr };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { code, stdout, stderr } = run(process.argv.slice(2), fs.readFileSync(0, 'utf8'));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
