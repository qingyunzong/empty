#!/usr/bin/env node
// Offline planning CLI. Reads a JSON array of commands (file arg or stdin),
// executes them sequentially against a single Store, prints JSON results.
import { readFileSync } from 'node:fs';
import { Store, PlanError, toSlot } from './src/store.js';

function normalizeOrder(raw) {
  return {
    id: raw.id,
    workcenter: raw.workcenter,
    start: toSlot(raw.start),
    end: toSlot(raw.end),
    qty: raw.qty,
  };
}

function normalizePatch(raw) {
  const patch = {};
  if (raw.workcenter !== undefined) patch.workcenter = raw.workcenter;
  if (raw.start !== undefined) patch.start = toSlot(raw.start);
  if (raw.end !== undefined) patch.end = toSlot(raw.end);
  if (raw.qty !== undefined) patch.qty = raw.qty;
  return patch;
}

export function runCommands(commands, store = new Store()) {
  const results = [];
  for (const cmd of commands) {
    try {
      switch (cmd.op) {
        case 'set_capacity':
          store.setCapacity(cmd.workcenter, toSlot(cmd.start), toSlot(cmd.end), cmd.capacity);
          results.push({ ok: true });
          break;
        case 'begin':
          results.push(store.begin());
          break;
        case 'read':
          results.push(store.read(cmd.txn, cmd.workcenter, toSlot(cmd.start), toSlot(cmd.end)));
          break;
        case 'insert':
          results.push(store.insert(cmd.txn, normalizeOrder(cmd.order)));
          break;
        case 'adjust':
          results.push(store.adjust(cmd.txn, cmd.orderId, normalizePatch(cmd.patch ?? {})));
          break;
        case 'cancel':
          results.push(store.cancel(cmd.txn, cmd.orderId));
          break;
        case 'commit':
          results.push(store.commit(cmd.txn));
          break;
        case 'abort':
          results.push(store.abort(cmd.txn));
          break;
        default:
          throw new PlanError('E_INPUT', `unknown op: ${cmd.op}`);
      }
    } catch (err) {
      if (err instanceof PlanError) {
        results.push({ error: { code: err.code, message: err.message, details: err.details } });
      } else {
        throw err;
      }
    }
  }
  return results;
}

function main() {
  const arg = process.argv[2];
  const text = arg && arg !== '-' ? readFileSync(arg, 'utf8') : readFileSync(0, 'utf8');
  const input = JSON.parse(text);
  const commands = Array.isArray(input) ? input : input.commands;
  if (!Array.isArray(commands)) {
    console.error('input must be a JSON array of commands or { "commands": [...] }');
    process.exit(2);
  }
  const results = runCommands(commands);
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
