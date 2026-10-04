#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SyncError, EXIT_CODES } from './errors.js';
import { ParamRegistry } from './registry.js';
import { Store } from './store.js';
import { makeLibrary, mergeLibraries } from './sync.js';

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadRegistry(defFile) {
  if (!defFile) throw new SyncError('VALIDATION', '--def <params.json> is required');
  return new ParamRegistry(readJsonFile(defFile));
}

function out(file, data) {
  const text = JSON.stringify(data, null, 2);
  if (file) fs.writeFileSync(file, text + '\n');
  else fs.writeSync(1, text + '\n');
}

function fail(err) {
  const code = err instanceof SyncError ? err.code : 'INTERNAL';
  const body = { error: code, message: err.message };
  if (err.details !== undefined) body.details = err.details;
  fs.writeSync(2, JSON.stringify(body) + '\n');
  process.exit(EXIT_CODES[code] ?? 1);
}

const PHASES = { unlock: 'unlocked', params: 'params-reverted', certs: 'certs-cleared' };

function cmdPack(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      def: { type: 'string' },
      changes: { type: 'string' },
      set: { type: 'string', multiple: true },
      node: { type: 'string', default: 'engineer' },
      out: { type: 'string' },
    },
  });
  const registry = loadRegistry(v.def);
  let changes = v.changes ? readJsonFile(v.changes) : [];
  for (const s of v.set ?? []) {
    const eq = s.indexOf('=');
    if (eq === -1) throw new SyncError('VALIDATION', `bad --set, want key=value: ${s}`);
    changes.push({ op: 'set', key: s.slice(0, eq), value: JSON.parse(s.slice(eq + 1)) });
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new SyncError('VALIDATION', 'pack requires at least one change');
  }
  // Validate + capture against a scratch store so interlocks see full state.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'param-sync-pack-'));
  const store = new Store(scratch, registry, { node: v.node });
  const entries = [];
  for (const c of changes) {
    if (c.op === 'set') entries.push(...store.set(c.key, c.value));
    else if (c.op === 'lock') entries.push(...store.lock(c.key));
    else if (c.op === 'unlock') entries.push(...store.unlock(c.key));
    else throw new SyncError('VALIDATION', `unknown change op: ${c.op}`);
  }
  const lib = makeLibrary(v.node, entries);
  out(v.out, lib);
  if (v.out) fs.writeSync(1, JSON.stringify({ ok: true, entries: entries.length }) + '\n');
}

function cmdApply(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      def: { type: 'string' },
      store: { type: 'string' },
      pack: { type: 'string' },
      node: { type: 'string', default: 'controller' },
      'safe-set': { type: 'string' },
    },
  });
  if (!v.store) throw new SyncError('VALIDATION', '--store <dir> is required');
  if (!v.pack) throw new SyncError('VALIDATION', '--pack <lib.json> is required');
  const registry = loadRegistry(v.def);
  const store = Store.load(v.store, registry, { node: v.node });
  if (v['safe-set']) store.commitSafeSet(readJsonFile(v['safe-set']));
  const pack = readJsonFile(v.pack);
  store.applyEntries(pack.entries ?? []);
  out(null, { ok: true, state: store.snapshot() });
}

function cmdFeedback(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      def: { type: 'string' },
      store: { type: 'string' },
      node: { type: 'string', default: 'controller' },
      out: { type: 'string' },
    },
  });
  if (!v.store) throw new SyncError('VALIDATION', '--store <dir> is required');
  const registry = loadRegistry(v.def);
  const store = Store.load(v.store, registry, { node: v.node });
  const lib = makeLibrary(v.node, store.exportEntries());
  out(v.out, lib);
  if (v.out) fs.writeSync(1, JSON.stringify({ ok: true, entries: lib.entries.length }) + '\n');
}

function cmdSync(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      def: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!v.a || !v.b) throw new SyncError('VALIDATION', 'sync requires --a and --b libraries');
  const registry = loadRegistry(v.def);
  const merged = mergeLibraries(readJsonFile(v.a), readJsonFile(v.b), registry);
  out(v.out, merged);
  if (merged.pending.length > 0) {
    throw new SyncError('CONFLICT',
      `safety-critical conflict pending: ${merged.pending.map((p) => p.key).join(', ')}`,
      { pending: merged.pending.map((p) => p.key) });
  }
  if (v.out) fs.writeSync(1, JSON.stringify({ ok: true, entries: merged.entries.length }) + '\n');
}

function cmdRollback(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      def: { type: 'string' },
      store: { type: 'string' },
      node: { type: 'string', default: 'controller' },
      phase: { type: 'string' },
    },
  });
  if (!v.store) throw new SyncError('VALIDATION', '--store <dir> is required');
  const registry = loadRegistry(v.def);
  const store = Store.load(v.store, registry, { node: v.node });
  if (v.phase) {
    const phase = PHASES[v.phase];
    if (!phase) throw new SyncError('ROLLBACK', `unknown phase: ${v.phase}`);
    store.rollback(phase);
    out(null, { ok: true, phase });
  } else {
    store.rollbackAll();
    out(null, { ok: true, phase: store.state.rollbackPhase });
  }
}

function cmdCert(args) {
  const { values: v } = parseArgs({
    args,
    options: {
      def: { type: 'string' },
      store: { type: 'string' },
      node: { type: 'string', default: 'controller' },
      issue: { type: 'string' },
      value: { type: 'string' },
      list: { type: 'boolean', default: false },
    },
  });
  if (!v.store) throw new SyncError('VALIDATION', '--store <dir> is required');
  const registry = loadRegistry(v.def);
  const store = Store.load(v.store, registry, { node: v.node });
  if (v.list) {
    out(null, { certs: store.state.certs });
    return;
  }
  if (!v.issue) throw new SyncError('VALIDATION', 'cert requires --issue <key> or --list');
  store.issueCert(v.issue, v.value ?? 'issued');
  out(null, { ok: true, key: v.issue });
}

const COMMANDS = {
  pack: cmdPack,
  apply: cmdApply,
  feedback: cmdFeedback,
  sync: cmdSync,
  rollback: cmdRollback,
  cert: cmdCert,
};

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const handler = COMMANDS[cmd];
  if (!handler) {
    fs.writeSync(2, JSON.stringify({
      error: 'USAGE',
      message: `usage: param-sync <${Object.keys(COMMANDS.join('|'))}> [options]`,
    }) + '\n');
    process.exit(1);
  }
  try {
    handler(rest);
  } catch (err) {
    fail(err);
  }
}

main();
