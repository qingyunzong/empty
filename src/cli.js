#!/usr/bin/env node
// wx-merge: offline merge of multi-station weather correction streams.
//
//   node src/cli.js ingest --store STORE.jsonl --site SITE --input STREAM.jsonl
//   node src/cli.js merge  --out OUT.jsonl IN1.jsonl IN2.jsonl [IN3.jsonl ...]
//   node src/cli.js query  --store STORE.jsonl [--site S] [--from ISO] [--to ISO] [--include-invalid]
//   node src/cli.js compact --store STORE.jsonl
//
// Errors are reported on stderr as {"error":CODE,"message":...} with exit 1:
//   BAD_RANGE | UNKNOWN_SITE | TOMBSTONE_HIT

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  WxError,
  loadStore,
  serializeStore,
  ingestRecords,
  mergeStores,
  compactStore,
  queryStore,
} from './store.js';

const BOOL_FLAGS = new Set(['include-invalid']);

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) {
        opts[name] = true;
      } else {
        if (i + 1 >= argv.length) throw new WxError('BAD_RANGE', `missing value for --${name}`);
        opts[name] = argv[++i];
      }
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

function readJsonl(path) {
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new WxError('BAD_RANGE', `${path}:${i + 1}: invalid JSON`);
      }
    });
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path);
}

function cmdIngest(opts) {
  const { store: storePath, site, input } = opts;
  if (!storePath || !site || !input) {
    throw new WxError('BAD_RANGE', 'ingest requires --store, --site and --input');
  }
  const store = loadStore(storePath);
  const records = readJsonl(input);
  const res = ingestRecords(store, site, records);
  writeAtomic(storePath, serializeStore(store));
  return { command: 'ingest', store: storePath, site, ...res };
}

function cmdMerge(opts, pos) {
  const out = opts.out;
  if (!out || pos.length === 0) {
    throw new WxError('BAD_RANGE', 'merge requires --out and at least one input store');
  }
  const stores = pos.map((p) => loadStore(p));
  const merged = mergeStores(stores);
  writeAtomic(out, serializeStore(merged));
  return {
    command: 'merge',
    out,
    inputs: pos.length,
    sites: merged.sites.size,
    events: merged.events.length,
  };
}

function cmdQuery(opts) {
  if (!opts.store) throw new WxError('BAD_RANGE', 'query requires --store');
  const store = loadStore(opts.store);
  return queryStore(store, {
    site: opts.site ?? null,
    from: opts.from ?? null,
    to: opts.to ?? null,
    includeInvalid: opts['include-invalid'] === true,
  });
}

function cmdCompact(opts) {
  if (!opts.store) throw new WxError('BAD_RANGE', 'compact requires --store');
  const store = loadStore(opts.store);
  const { store: compacted, dropped, base } = compactStore(store);
  writeAtomic(opts.store, serializeStore(compacted));
  return {
    command: 'compact',
    store: opts.store,
    dropped,
    events: compacted.events.length,
    base,
  };
}

const USAGE = `usage:
  wx-merge ingest  --store STORE.jsonl --site SITE --input STREAM.jsonl
  wx-merge merge   --out OUT.jsonl IN1.jsonl IN2.jsonl [...]
  wx-merge query   --store STORE.jsonl [--site S] [--from ISO] [--to ISO] [--include-invalid]
  wx-merge compact --store STORE.jsonl`;

// In-process entry point (also used by tests): returns {code, stdout, stderr}.
export function runCli(argv) {
  const [cmd, ...rest] = argv;
  try {
    const { opts, pos } = parseArgs(rest);
    switch (cmd) {
      case 'ingest':
        return { code: 0, stdout: JSON.stringify(cmdIngest(opts)) + '\n', stderr: '' };
      case 'merge':
        return { code: 0, stdout: JSON.stringify(cmdMerge(opts, pos)) + '\n', stderr: '' };
      case 'query': {
        const rows = cmdQuery(opts);
        return {
          code: 0,
          stdout: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
          stderr: '',
        };
      }
      case 'compact':
        return { code: 0, stdout: JSON.stringify(cmdCompact(opts)) + '\n', stderr: '' };
      default:
        return { code: 2, stdout: '', stderr: USAGE + '\n' };
    }
  } catch (err) {
    if (err instanceof WxError) {
      return {
        code: 1,
        stdout: '',
        stderr: JSON.stringify({ error: err.code, message: err.message }) + '\n',
      };
    }
    throw err;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
