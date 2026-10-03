#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { EvidenceError } from './errors.js';

const EXIT_CODES = { E_CYCLE: 2, E_SOURCE_GONE: 3, E_WAL: 4, E_HASH: 5 };

function usage() {
  return `usage: evidence [--dir PATH] <command> [args]

commands:
  add <fact.json>      add fact: {"id":"f1","source":"s1","value":1}
  derive <rule.json>   add derived node: {"id":"d1","op":"count|sum","min":N,"inputs":[...]}
  remove <factId>      delete a fact (tombstone event)
  revoke <sourceId>    revoke a source (degrades dependent conclusions)
  restore <sourceId>   restore a revoked source
  status <node>        print node status (valid|degraded|unknown|revoked|deleted)
  snapshot             write a snapshot and compact the WAL
  verifylog            verify snapshot checksum + WAL hash chain`;
}

function parseArgs(argv) {
  const args = [...argv];
  let dir = process.env.EVIDENCE_DIR ?? '.evidence';
  const i = args.indexOf('--dir');
  if (i !== -1) {
    dir = args[i + 1];
    args.splice(i, 2);
  }
  return { dir, command: args[0], rest: args.slice(1) };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new EvidenceError('E_USAGE', `cannot read JSON from ${file}: ${err.message}`);
  }
}

function requireArg(value, name) {
  if (value === undefined) throw new EvidenceError('E_USAGE', `missing argument: ${name}`);
  return value;
}

// Returns a process exit code. `io` allows in-process testing.
export function runCli(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s));
  const err = io.err ?? ((s) => console.error(s));
  try {
    const { dir, command, rest } = parseArgs(argv);
    if (!command || command === 'help' || command === '--help') {
      out(usage());
      return command ? 0 : 1;
    }
    const store = Store.open(dir);
    switch (command) {
      case 'add': {
        const fact = readJson(requireArg(rest[0], 'fact.json'));
        if (!fact.id || !fact.source) throw new EvidenceError('E_USAGE', 'fact requires id and source');
        const event = store.append('ADD_FACT', fact);
        out(JSON.stringify({ ok: true, seq: event.seq }));
        return 0;
      }
      case 'derive': {
        const rule = readJson(requireArg(rest[0], 'rule.json'));
        if (!rule.id || !Array.isArray(rule.inputs) || !['count', 'sum'].includes(rule.op)) {
          throw new EvidenceError('E_USAGE', 'rule requires id, op (count|sum) and inputs[]');
        }
        const event = store.append('ADD_DERIVED', rule);
        out(JSON.stringify({ ok: true, seq: event.seq }));
        return 0;
      }
      case 'remove': {
        const event = store.append('DELETE_FACT', { id: requireArg(rest[0], 'factId') });
        out(JSON.stringify({ ok: true, seq: event.seq }));
        return 0;
      }
      case 'revoke': {
        const event = store.append('REVOKE_SOURCE', { id: requireArg(rest[0], 'sourceId') });
        out(JSON.stringify({ ok: true, seq: event.seq }));
        return 0;
      }
      case 'restore': {
        const event = store.append('RESTORE_SOURCE', { id: requireArg(rest[0], 'sourceId') });
        out(JSON.stringify({ ok: true, seq: event.seq }));
        return 0;
      }
      case 'status': {
        out(JSON.stringify(store.status(requireArg(rest[0], 'node'))));
        return 0;
      }
      case 'snapshot': {
        const snap = store.snapshot();
        out(JSON.stringify({ ok: true, ...snap }));
        return 0;
      }
      case 'verifylog': {
        out(JSON.stringify(store.verify()));
        return 0;
      }
      default:
        throw new EvidenceError('E_USAGE', `unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof EvidenceError) {
      err(`${error.code}: ${error.message}`);
      return EXIT_CODES[error.code] ?? 1;
    }
    err(`E_INTERNAL: ${error.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
