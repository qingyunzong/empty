#!/usr/bin/env node
// Usage:
//   node src/cli.js init  <file> --limit <num/den>
//   node src/cli.js apply <file> '<op-json>' [...more ops]
//   node src/cli.js state <file>
//   node src/cli.js replay <file>
// Recovery summary is always printed to stderr when a store is opened.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Engine, AppError, E_PARSE, E_IO } from './engine.js';
import { Store } from './store.js';

function replayEngine(records) {
  const engine = new Engine();
  for (const rec of records) engine.apply(rec);
  return engine;
}

// Returns an exit code; output goes through the injected writers.
export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const out = (obj) => io.stdout(JSON.stringify(obj) + '\n');
  const noteRecovery = (r) => io.stderr(`recovery: ${JSON.stringify(r)}\n`);
  try {
    const [cmd, file, ...rest] = argv;
    if (!cmd || !file) {
      throw new AppError(E_PARSE, 'usage: cli.js <init|apply|state|replay> <file> [args]');
    }
    switch (cmd) {
      case 'init': {
        const li = rest.indexOf('--limit');
        if (li < 0 || rest[li + 1] === undefined) throw new AppError(E_PARSE, 'init requires --limit <num/den>');
        if (fs.existsSync(file) && fs.statSync(file).size > 0) {
          throw new AppError(E_IO, `store ${file} is not empty; refusing to re-init`);
        }
        const engine = new Engine();
        const { record } = engine.apply({ op: 'init', limit: rest[li + 1] });
        const { store, recovery } = Store.open(file);
        noteRecovery(recovery);
        store.append({ seq: 0, ...record });
        out({ ok: true, limit: record.limit });
        return 0;
      }
      case 'apply': {
        const { store, records, recovery } = Store.open(file);
        noteRecovery(recovery);
        const engine = replayEngine(records);
        let seq = records.length;
        const results = [];
        for (const arg of rest) {
          let parsed;
          try { parsed = JSON.parse(arg); }
          catch { throw new AppError(E_PARSE, `invalid JSON op: ${arg}`); }
          const { record, result } = engine.apply(parsed);
          store.append({ seq: seq++, ...record });
          results.push(result);
        }
        out({ ok: true, results });
        return 0;
      }
      case 'state':
      case 'replay': {
        const { records, recovery } = Store.open(file);
        noteRecovery(recovery);
        out({ ok: true, recovery, state: replayEngine(records).snapshot() });
        return 0;
      }
      default:
        throw new AppError(E_PARSE, `unknown command ${cmd}`);
    }
  } catch (e) {
    if (e instanceof AppError) {
      out({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
    } else {
      out({ ok: false, error: { code: 'E_INTERNAL', message: String((e && e.message) || e) } });
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
