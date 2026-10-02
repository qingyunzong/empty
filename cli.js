#!/usr/bin/env node
// Usage: node cli.js [--dir <dataDir>] <add|del|undo|query|verify>
// Input: JSONL on stdin (verify takes none). Output: JSON on stdout.
import fs from 'node:fs';
import { Store } from './src/store.js';
import { IndexError } from './src/index.js';

function parseArgs(argv) {
  let dir = './data';
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') {
      dir = argv[i + 1];
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  return { dir, command: rest[0] };
}

function parseJsonl(raw) {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new IndexError('E_PARSE', `line ${i + 1}: invalid JSON`);
    }
  });
}

const COMMANDS = new Set(['add', 'del', 'undo', 'query', 'verify']);

// In-process entry point (also used by tests). Returns { code, lines }.
export function main(argv, input = '') {
  const { dir, command } = parseArgs(argv);
  if (!COMMANDS.has(command)) {
    return { code: 2, lines: [], stderr: 'usage: node cli.js [--dir <dataDir>] <add|del|undo|query|verify>\n' };
  }
  const lines = [];
  try {
    const store = new Store(dir);
    if (command === 'verify') {
      lines.push({ ok: true, ...store.verify() });
    } else if (command === 'add') {
      lines.push({ ok: true, ...store.addBatch(parseJsonl(input)) });
    } else if (command === 'del') {
      lines.push({ ok: true, ...store.delBatch(parseJsonl(input)) });
    } else if (command === 'undo') {
      lines.push({ ok: true, ...store.undo(parseJsonl(input)) });
    } else if (command === 'query') {
      const index = store.foldIndex();
      for (const q of parseJsonl(input)) {
        if (!q || typeof q !== 'object') throw new IndexError('E_PARSE', 'query must be an object');
        let results;
        if (q.phrase !== undefined) results = index.queryPhrase(q.phrase);
        else if (q.term !== undefined) results = index.queryTerm(q.term);
        else if (q.near !== undefined) {
          if (!Array.isArray(q.near) || q.near.length !== 2) {
            throw new IndexError('E_PARSE', 'near must be [termA, termB]');
          }
          results = index.queryNear(q.near[0], q.near[1], q.k === undefined ? 3 : q.k);
        } else {
          throw new IndexError('E_PARSE', 'query needs "phrase", "term" or "near"');
        }
        lines.push({ ok: true, results });
      }
    }
    return { code: 0, lines };
  } catch (err) {
    const error = err instanceof IndexError
      ? { code: err.code, message: err.message }
      : { code: 'E_INTERNAL', message: String(err && err.message) };
    return { code: 1, lines: [{ ok: false, error }] };
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;
if (invokedAsScript) {
  const result = main(process.argv.slice(2), fs.readFileSync(0, 'utf8'));
  if (result.stderr) process.stderr.write(result.stderr);
  for (const line of result.lines) process.stdout.write(`${JSON.stringify(line)}\n`);
  process.exit(result.code);
}
