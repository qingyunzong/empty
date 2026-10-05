#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EXIT_CODES, MergeError } from './errors.js';
import { parseJsonl } from './record.js';
import { Store } from './store.js';

const USAGE = `usage:
  weather-merge ingest <store> <file...>     validate & add JSONL records (- = stdin)
  weather-merge merge  <out> <file...>       permissive union of JSONL stores into <out>
  weather-merge query  <store> [--site S] [--from T] [--to T] [--include-invalid]
  weather-merge compact <store> [--out F]    drop superseded records covered by min frontier vector

record types (JSONL, one per line):
  {"type":"site","site":"S1","op":"register"|"delete","origin":"O1","seq":1,"vector":{"O1":1}}
  {"type":"correction","site":"S1","time":"2026-01-01T00:00:00Z","delta":-2.5,"origin":"O1","seq":2}
  {"type":"frontier","origin":"O2","vector":{"O1":5,"O2":3}}

errors: BAD_RANGE (exit 2), UNKNOWN_SITE (exit 3), TOMBSTONE_HIT (exit 4)`;

// io allows tests to drive the CLI in-process:
// { readStdin: () => string, stdout: (s) => void, stderr: (s) => void }
export function main(argv, io = {}) {
  const readStdin = io.readStdin ?? (() => readFileSync(0, 'utf8'));
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));

  const readJsonlFile = (path) => {
    const text = path === '-' ? readStdin() : readFileSync(path, 'utf8');
    return parseJsonl(text, path === '-' ? '<stdin>' : path);
  };
  const loadStore = (path, { mustExist = false } = {}) => {
    if (!existsSync(path)) {
      if (mustExist) throw new MergeError('BAD_RANGE', `store not found: ${path}`);
      return new Store();
    }
    return Store.fromJsonl(readFileSync(path, 'utf8'), path);
  };
  const saveStore = (store, path) => writeFileSync(path, store.toJsonl());

  const parseFlags = (args, spec) => {
    const opts = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('--')) {
        if (!(a in spec)) throw new MergeError('BAD_RANGE', `unknown flag ${a}`);
        if (spec[a] === 'bool') opts[a] = true;
        else opts[a] = args[++i];
      } else {
        rest.push(a);
      }
    }
    return [opts, rest];
  };

  try {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case 'ingest': {
        const [storePath, ...files] = args;
        if (!storePath || files.length === 0) throw new MergeError('BAD_RANGE', 'ingest needs <store> and at least one file');
        const store = loadStore(storePath);
        const records = [];
        for (const f of files) for (const rec of readJsonlFile(f)) records.push(rec);
        store.ingestAll(records);
        saveStore(store, storePath);
        return 0;
      }
      case 'merge': {
        const [out, ...files] = args;
        if (!out || files.length === 0) throw new MergeError('BAD_RANGE', 'merge needs <out> and at least one file');
        const store = new Store();
        for (const f of files) for (const rec of readJsonlFile(f)) store.add(rec);
        saveStore(store, out);
        return 0;
      }
      case 'query': {
        const [opts, rest] = parseFlags(args, {
          '--site': 'value', '--from': 'value', '--to': 'value', '--include-invalid': 'bool',
        });
        if (rest.length !== 1) throw new MergeError('BAD_RANGE', 'query needs exactly one <store>');
        const store = loadStore(rest[0], { mustExist: true });
        for (const row of store.query({
          site: opts['--site'] ?? null,
          from: opts['--from'] ?? null,
          to: opts['--to'] ?? null,
          includeInvalid: Boolean(opts['--include-invalid']),
        })) {
          stdout(JSON.stringify(row) + '\n');
        }
        return 0;
      }
      case 'compact': {
        const [opts, rest] = parseFlags(args, { '--out': 'value' });
        if (rest.length !== 1) throw new MergeError('BAD_RANGE', 'compact needs exactly one <store>');
        const store = loadStore(rest[0], { mustExist: true });
        saveStore(store.compact(), opts['--out'] ?? rest[0]);
        return 0;
      }
      default:
        stderr(USAGE + '\n');
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
    }
  } catch (err) {
    if (err instanceof MergeError) {
      stderr(`error ${err.code}: ${err.message}\n`);
      return EXIT_CODES[err.code] ?? 1;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
