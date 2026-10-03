#!/usr/bin/env node
// settle CLI — offline settlement accounts + online risk index builder.
//
//   node cli.js [--dir D] build-index [--batch N] [--delay-ms N]
//   node cli.js [--dir D] tx '{"ops":[...]}'
//   node cli.js [--dir D] query --risk R [--at V] [--scan]
//   node cli.js [--dir D] status
//   node cli.js [--dir D] crash --backfill
//
// Success: JSON on stdout, exit 0. Errors: JSON on stderr, non-zero exit.

import fs from 'node:fs';
import { Store, acquireLock, withLock } from './src/store.js';
import {
  DomainError, applyTx, queryRisk, beginBackfill, backfillBatch, statusView,
} from './src/engine.js';

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else pos.push(a);
  }
  return { opts, pos };
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function cmdBuildIndex(store, opts) {
  const batch = Math.max(1, Number(opts.batch ?? 25));
  const delay = Math.max(0, Number(opts['delay-ms'] ?? 0));
  let state = withLock(store, () => {
    const s = store.load();
    if (s.index.state === 'none') return store.commit(beginBackfill(s));
    return s;
  });
  while (state.index.state === 'building') {
    state = withLock(store, () => store.commit(backfillBatch(store.load(), batch)));
    if (state.index.state === 'building' && delay) sleepMs(delay); // lock released between batches
  }
  return { ok: true, ...statusView(state) };
}

function cmdTx(store, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DomainError('E_BAD_JSON', 'tx body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || !('ops' in parsed)) {
    throw new DomainError('E_BAD_JSON', 'tx body must be an object with an "ops" array');
  }
  const state = withLock(store, () => store.commit(applyTx(store.load(), parsed.ops)));
  return { ok: true, version: state.version };
}

function cmdQuery(store, opts) {
  if (typeof opts.risk !== 'string') throw new DomainError('E_USAGE', 'query requires --risk R');
  const state = store.load();
  const at = opts.at === undefined || opts.at === true ? undefined : Number(opts.at);
  const result = queryRisk(state, { risk: opts.risk, at, forceScan: Boolean(opts.scan) });
  return { ok: true, risk: opts.risk, ...result };
}

function cmdStatus(store) {
  return { ok: true, ...statusView(store.load()) };
}

// Simulates a crash mid-backfill: scans half of the remaining accounts,
// commits that progress, then dies BEFORE writing the index watermark —
// without releasing the lock (stale-lock recovery is exercised on restart).
function cmdCrash(store) {
  const release = acquireLock(store);
  let state = store.load();
  if (state.index.state === 'ready') {
    release();
    throw new DomainError('E_INDEX_READY', 'index already built; nothing to crash');
  }
  if (state.index.state === 'none') state = store.commit(beginBackfill(state));
  const remaining = state.backfill.order.length - state.backfill.cursor;
  // Scan half, but always leave at least one account (and the watermark) unwritten.
  const half = Math.min(Math.ceil(remaining / 2), Math.max(remaining - 1, 0));
  if (half > 0) state = store.commit(backfillBatch(state, half));
  const view = statusView(state);
  fs.writeSync(2, JSON.stringify({
    error: { code: 'E_CRASH', message: 'simulated crash during backfill (before watermark)', status: view },
  }) + '\n');
  process.exit(2); // abrupt exit: lock left held, watermark unwritten
}

function main() {
  const { opts, pos } = parseArgs(process.argv.slice(2));
  const dir = typeof opts.dir === 'string' ? opts.dir : (process.env.SETTLE_DIR ?? './.settle');
  const store = new Store(dir);
  const cmd = pos[0];
  switch (cmd) {
    case 'build-index': return cmdBuildIndex(store, opts);
    case 'tx': {
      if (pos[1] === undefined) throw new DomainError('E_USAGE', 'tx requires a JSON body argument');
      return cmdTx(store, pos[1]);
    }
    case 'query': return cmdQuery(store, opts);
    case 'status': return cmdStatus(store);
    case 'crash': {
      if (!opts.backfill) throw new DomainError('E_USAGE', 'crash requires --backfill');
      return cmdCrash(store);
    }
    default:
      throw new DomainError('E_USAGE', `unknown command: ${cmd ?? '(none)'}`);
  }
}

try {
  const out = main();
  if (out !== undefined) process.stdout.write(JSON.stringify(out) + '\n');
} catch (e) {
  const code = e instanceof DomainError ? e.code : 'E_INTERNAL';
  process.stderr.write(JSON.stringify({ error: { code, message: e.message } }) + '\n');
  process.exitCode = 1;
}
