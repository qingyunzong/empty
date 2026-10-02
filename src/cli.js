#!/usr/bin/env node
import fs from 'node:fs';
import {
  initStore,
  loadStore,
  buildEvents,
  appendBatch,
  mergeLines,
  dumpLines,
  statusSummary,
  recordDetail,
  StoreError,
} from './store.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseJsonLines(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  return lines.map((s, i) => {
    try {
      return JSON.parse(s);
    } catch {
      throw new StoreError('BAD_INPUT', `line ${i + 1} is not valid JSON`);
    }
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function needString(flags, name) {
  if (typeof flags[name] !== 'string' || flags[name].length === 0) {
    throw new StoreError('USAGE', `--${name} requires a value`);
  }
  return flags[name];
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const storeDir = typeof flags.store === 'string' ? flags.store : (process.env.OBS_STORE || '.obs');
  if (!cmd) {
    throw new StoreError('USAGE', 'usage: obs [--store DIR] <init|put|correct|delete|merge|status> [flags]');
  }

  if (cmd === 'init') {
    const node = needString(flags, 'node');
    const nodes = typeof flags.nodes === 'string'
      ? flags.nodes.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const retention = flags.retention !== undefined ? Number(flags.retention) : 0;
    const config = initStore(storeDir, { node, nodes, retention });
    out({ ok: true, ...config });
    return;
  }

  if (cmd === 'put' || cmd === 'correct' || cmd === 'delete') {
    const state = loadStore(storeDir);
    const inputs = parseJsonLines(readStdin());
    const events = buildEvents(state, cmd, inputs);
    appendBatch(storeDir, events);
    for (const ev of events) {
      out({
        ok: true,
        op: ev.op,
        key: ev.key,
        value: ev.version.value,
        deleted: ev.version.deleted,
        clock: ev.version.clock,
        lamport: ev.version.lamport,
      });
    }
    return;
  }

  if (cmd === 'merge') {
    const state = loadStore(storeDir);
    const lines = parseJsonLines(readStdin());
    for (const r of mergeLines(state, lines)) out(r);
    return;
  }

  if (cmd === 'status') {
    const state = loadStore(storeDir);
    if (flags.dump) {
      for (const l of dumpLines(state)) out(l);
      return;
    }
    if (flags.key !== undefined) {
      const key = needString(flags, 'key');
      const detail = recordDetail(state, key);
      if (!detail) throw new StoreError('NOT_FOUND', `key "${key}" not found`);
      out(detail);
      return;
    }
    out(statusSummary(state));
    return;
  }

  throw new StoreError('USAGE', `unknown command "${cmd}"`);
}

try {
  main();
} catch (e) {
  const code = e instanceof StoreError ? e.code : 'INTERNAL';
  process.stderr.write(JSON.stringify({ code, msg: String(e.message || e) }) + '\n');
  process.exit(1);
}
