#!/usr/bin/env node
import fs from 'node:fs';
import { Store } from './store.js';
import { EvidenceError, E_INPUT } from './errors.js';

const USAGE = `evidence - evidence chain CLI

Usage: evidence <command> [args] [--dir <path>]

Commands:
  add <fact.json>       Add a fact: {"id":"f1","source":"s1","value":1,"data":{...}}
  derive <rule.json>    Add a derived node: {"id":"r1","op":"count|sum","premises":["f1"],"threshold":1}
  revoke <sourceId>     Revoke a source (reversible event)
  restore <sourceId>    Restore a revoked source
  remove <factId>       Remove a fact (tombstone; restore will not resurrect it)
  status <nodeId>       Print node state: valid | degraded | unknown | removed
  snapshot              Write a consistent snapshot and truncate the WAL
  verifylog             Verify snapshot integrity and the WAL hash chain

Options:
  --dir, -d <path>      Data directory (default: $EVIDENCE_DIR or .evidence)
`;

function parseArgs(argv) {
  const positional = [];
  let dir = process.env.EVIDENCE_DIR || '.evidence';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' || argv[i] === '-d') {
      dir = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, dir };
}

function readJsonArg(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new EvidenceError(E_INPUT, `cannot read ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new EvidenceError(E_INPUT, `${file} is not valid JSON`);
  }
}

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main(argv) {
  const { positional, dir } = parseArgs(argv);
  const [command, ...args] = positional;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  switch (command) {
    case 'add': {
      const fact = readJsonArg(args[0]);
      const store = Store.open(dir);
      const event = store.commit('add_fact', fact);
      out({ ok: true, seq: event.seq, id: fact.id });
      return 0;
    }
    case 'derive': {
      const rule = readJsonArg(args[0]);
      const store = Store.open(dir);
      const event = store.commit('add_rule', rule);
      out({ ok: true, seq: event.seq, id: rule.id });
      return 0;
    }
    case 'revoke': {
      const store = Store.open(dir);
      const event = store.commit('revoke_source', { source: args[0] });
      out({ ok: true, seq: event.seq, source: args[0] });
      return 0;
    }
    case 'restore': {
      const store = Store.open(dir);
      const event = store.commit('restore_source', { source: args[0] });
      out({ ok: true, seq: event.seq, source: args[0] });
      return 0;
    }
    case 'remove': {
      const store = Store.open(dir);
      const event = store.commit('remove_fact', { id: args[0] });
      out({ ok: true, seq: event.seq, id: args[0] });
      return 0;
    }
    case 'status': {
      const store = Store.open(dir);
      out(store.graph.status(args[0]));
      return 0;
    }
    case 'snapshot': {
      const store = Store.open(dir);
      const snap = store.snapshot();
      out({ ok: true, lastSeq: snap.lastSeq, headHash: snap.headHash });
      return 0;
    }
    case 'verifylog': {
      out(Store.verify(dir));
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  if (e instanceof EvidenceError) {
    process.stderr.write(JSON.stringify({ error: e.code, message: e.message }) + '\n');
    process.exit(1);
  }
  throw e;
}
