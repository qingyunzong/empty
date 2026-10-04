#!/usr/bin/env node
import fs from 'node:fs';
import {
  initStore, appendOrders, createCheckpoint, rollback, verify, replay,
  loadManifest, decode, StoreError,
} from './store.js';
import { planSchedule } from './scheduler.js';

const EXIT_CODES = { E_CRC: 2, E_INDEX: 3, E_CAPACITY: 4, E_INPUT: 5 };

function fail(err) {
  const code = err instanceof StoreError ? err.code : 'E_INTERNAL';
  const error = { code, message: err.message };
  if (err.chunk !== undefined) error.chunk = err.chunk;
  if (err.decodedChunks !== undefined) error.decodedChunks = err.decodedChunks;
  if (err.state !== undefined) {
    error.prefixOrders = err.state.orders.map((o) => o.id);
    error.prefixCumulativeLoad = err.state.cumulativeLoad;
  }
  if (err.orders !== undefined) error.orders = err.orders;
  process.stderr.write(JSON.stringify({ error }) + '\n');
  process.exitCode = EXIT_CODES[code] ?? 1;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

function readOrders(flags) {
  const raw = flags.orders !== undefined ? flags.orders : fs.readFileSync(0, 'utf8');
  let orders;
  try {
    orders = JSON.parse(raw);
  } catch {
    throw new StoreError('E_INPUT', 'orders input is not valid JSON');
  }
  return orders;
}

function main() {
  const [cmd, dir, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!cmd || !dir) {
    process.stderr.write('usage: plan <init|add|schedule|checkpoint|rollback|verify|replay> <dir> [flags]\n');
    process.exitCode = 1;
    return;
  }
  let out;
  switch (cmd) {
    case 'init':
      initStore(dir, Number(flags.capacity));
      out = { ok: true };
      break;
    case 'add': {
      const r = appendOrders(dir, readOrders(flags));
      out = { ok: true, chunk: r.chunk, orders: r.state.orders.length, cumulativeLoad: r.state.cumulativeLoad };
      break;
    }
    case 'schedule': {
      const manifest = loadManifest(dir);
      const { state } = decode(dir, manifest);
      out = planSchedule(state.orders, manifest.capacity);
      break;
    }
    case 'checkpoint':
      out = { ok: true, ...createCheckpoint(dir, flags.name) };
      break;
    case 'rollback': {
      const r = rollback(dir, flags.name);
      out = { ok: true, checkpoint: r.checkpoint, chunk: r.chunk, orders: r.state.orders.length, cumulativeLoad: r.state.cumulativeLoad };
      break;
    }
    case 'verify':
      out = { ok: true, ...verify(dir) };
      break;
    case 'replay':
      replay(dir);
      out = { ok: true };
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exitCode = 1;
      return;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (err) {
  fail(err);
}
