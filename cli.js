#!/usr/bin/env node
// CLI: state is kept in a store file (snapshot format).
//   node cli.js ingest   <store> <log_id> <events.jsonl>
//   node cli.js merge    <store> <new_log_id> <log_id...>
//   node cli.js equiv    <store> <log_a> <log_b>
//   node cli.js explain  <store> <log_a> <log_b>
//   node cli.js snapshot <store> [outfile]
//   node cli.js restore  <store> <snapshot_file>
// Exit codes: OK/EQUAL=0, NOT_EQUAL=1, UNDECIDED=2, INVALID_INPUT=3, RESTORE_CORRUPT=4.

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './src/store.js';

export const EXIT_CODES = { OK: 0, EQUAL: 0, NOT_EQUAL: 1, UNDECIDED: 2, INVALID_INPUT: 3, RESTORE_CORRUPT: 4 };

function loadStore(path, create) {
  if (!existsSync(path)) {
    if (create) return { store: new Store() };
    return { result: { status: 'INVALID_INPUT', error: `store not found: ${path}` } };
  }
  const r = Store.restore(readFileSync(path, 'utf8'));
  if (r.status !== 'OK') return { result: { status: 'RESTORE_CORRUPT', error: r.error } };
  return { store: r.store };
}

export function runCli(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'ingest': {
      const [storePath, logId, file] = args;
      if (!storePath || !logId || !file) return { status: 'INVALID_INPUT', error: 'usage: ingest <store> <log_id> <events.jsonl>' };
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return { status: 'INVALID_INPUT', error: `cannot read file: ${file}` };
      }
      const events = [];
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          events.push(JSON.parse(lines[i]));
        } catch {
          return { status: 'INVALID_INPUT', error: `line ${i + 1}: invalid JSON` };
        }
      }
      const { store, result } = loadStore(storePath, true);
      if (result) return result;
      const r = store.ingest(logId, events);
      if (r.status === 'OK') writeFileSync(storePath, store.snapshot());
      return r;
    }
    case 'merge': {
      const [storePath, newId, ...ids] = args;
      if (!storePath || !newId || ids.length === 0) return { status: 'INVALID_INPUT', error: 'usage: merge <store> <new_log_id> <log_id...>' };
      const { store, result } = loadStore(storePath, false);
      if (result) return result;
      const r = store.merge(newId, ids);
      if (r.status === 'OK') writeFileSync(storePath, store.snapshot());
      return r;
    }
    case 'equiv':
    case 'explain': {
      const [storePath, a, b] = args;
      if (!storePath || !a || !b) return { status: 'INVALID_INPUT', error: `usage: ${cmd} <store> <log_a> <log_b>` };
      const { store, result } = loadStore(storePath, false);
      if (result) return result;
      return store[cmd](a, b);
    }
    case 'snapshot': {
      const [storePath, outFile] = args;
      if (!storePath) return { status: 'INVALID_INPUT', error: 'usage: snapshot <store> [outfile]' };
      const { store, result } = loadStore(storePath, false);
      if (result) return result;
      const text = store.snapshot();
      if (outFile) {
        writeFileSync(outFile, text);
        return { status: 'OK', file: outFile };
      }
      return { status: 'OK', snapshot: text };
    }
    case 'restore': {
      const [storePath, snapFile] = args;
      if (!storePath || !snapFile) return { status: 'INVALID_INPUT', error: 'usage: restore <store> <snapshot_file>' };
      let text;
      try {
        text = readFileSync(snapFile, 'utf8');
      } catch {
        return { status: 'INVALID_INPUT', error: `cannot read file: ${snapFile}` };
      }
      const r = Store.restore(text);
      if (r.status !== 'OK') return { status: 'RESTORE_CORRUPT', error: r.error };
      writeFileSync(storePath, text);
      return { status: 'OK', logs: r.store.logs.size };
    }
    default:
      return {
        status: 'INVALID_INPUT',
        error: 'usage: cli.js <ingest|merge|equiv|explain|snapshot|restore> ...',
      };
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = EXIT_CODES[result.status] ?? 0;
}
