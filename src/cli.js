#!/usr/bin/env node
// CLI over a snapshot-backed store file.
//
//   node src/cli.js ingest   <store> <log_id> <events.jsonl>   add a log (JSONL, one event per line)
//   node src/cli.js merge    <store> <a> <b> [new_id]          merge two logs into a new one
//   node src/cli.js equiv    <store> <a> <b>                   compare two logs
//   node src/cli.js explain  <store> <a> <b>                   compare with full diagnostics
//   node src/cli.js snapshot <store> <out>                     export a checksummed snapshot
//   node src/cli.js restore  <file>                            validate a snapshot file
//
// Exit codes: 0 = OK/EQUAL/NOT_EQUAL/UNDECIDED, 1 = INVALID_INPUT/RESTORE_CORRUPT, 2 = usage.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createStore,
  ingest,
  merge,
  equiv,
  explain,
  writeSnapshot,
  restore,
} from './store.js';

export function main(argv, { write = (s) => process.stdout.write(s + '\n') } = {}) {
  const emit = (out, code) => {
    write(JSON.stringify(out));
    return code;
  };
  const usage = () =>
    emit(
      { status: 'INVALID_INPUT', errors: ['usage: cli.js <ingest|merge|equiv|explain|snapshot|restore> ...'] },
      2,
    );

  const loadStore = (file, { allowMissing = false } = {}) => {
    const r = restore(file);
    if (r.status === 'RESTORE_CORRUPT') {
      if (allowMissing && r.reason && r.reason.startsWith('cannot read file')) {
        return { store: createStore() };
      }
      return { error: emit(r, 1) };
    }
    return { store: r.store };
  };

  const parseJsonl = (path) => {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      return { error: emit({ status: 'INVALID_INPUT', errors: [`cannot read ${path}: ${err.code || err.message}`] }, 1) };
    }
    const events = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        return { error: emit({ status: 'INVALID_INPUT', errors: [`${path}:${i + 1}: invalid JSON`] }, 1) };
      }
    }
    return { events };
  };

  const [cmd, ...args] = argv;

  switch (cmd) {
    case 'ingest': {
      const [storeFile, logId, jsonl] = args;
      if (!storeFile || !logId || !jsonl) return usage();
      const { store, error } = loadStore(storeFile, { allowMissing: true });
      if (error !== undefined) return error;
      const parsed = parseJsonl(jsonl);
      if (parsed.error !== undefined) return parsed.error;
      const r = ingest(store, logId, parsed.events);
      if (r.status !== 'OK') return emit(r, 1);
      writeSnapshot(store, storeFile);
      return emit(r, 0);
    }
    case 'merge': {
      const [storeFile, a, b, newId] = args;
      if (!storeFile || !a || !b) return usage();
      const { store, error } = loadStore(storeFile);
      if (error !== undefined) return error;
      const r = merge(store, a, b, newId);
      if (r.status !== 'OK') return emit(r, 1);
      writeSnapshot(store, storeFile);
      return emit(r, 0);
    }
    case 'equiv':
    case 'explain': {
      const [storeFile, a, b] = args;
      if (!storeFile || !a || !b) return usage();
      const { store, error } = loadStore(storeFile);
      if (error !== undefined) return error;
      const r = cmd === 'equiv' ? equiv(store, a, b) : explain(store, a, b);
      return emit(r, r.status === 'INVALID_INPUT' ? 1 : 0);
    }
    case 'snapshot': {
      const [storeFile, out] = args;
      if (!storeFile || !out) return usage();
      const { store, error } = loadStore(storeFile);
      if (error !== undefined) return error;
      return emit(writeSnapshot(store, out), 0);
    }
    case 'restore': {
      const [file] = args;
      if (!file) return usage();
      const r = restore(file);
      if (r.status === 'OK') return emit({ status: 'OK', file, logs: r.store.logs.size }, 0);
      return emit(r, 1);
    }
    default:
      return usage();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
