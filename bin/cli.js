#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Database } from '../src/index.js';

function readInput(argv) {
  const file = argv[2];
  if (file && file !== '-') {
    return readFileSync(file, 'utf8');
  }
  return readFileSync(0, 'utf8'); // stdin
}

export function runPlan(plan) {
  const commands = Array.isArray(plan) ? plan : plan.commands;
  if (!Array.isArray(commands)) {
    throw new TypeError('input must be a JSON array or an object with a "commands" array');
  }
  const db = new Database();
  const transactions = new Map();
  const results = [];

  const requireTx = (name) => {
    const tx = transactions.get(name);
    if (!tx) throw new Error(`unknown transaction: ${name}`);
    return tx;
  };

  for (const command of commands) {
    const { op } = command;
    try {
      switch (op) {
        case 'setCapacity': {
          db.setCapacity(command.workcenter, command.slot, command.capacity);
          results.push({ op, ok: true });
          break;
        }
        case 'begin': {
          const tx = db.begin();
          transactions.set(command.tx, tx);
          results.push({ op, ok: true, tx: command.tx, snapshotSeq: tx.snapshotSeq });
          break;
        }
        case 'read': {
          const tx = requireTx(command.tx);
          const occupancy = tx.readOccupancy(command.workcenter, command.start, command.end);
          results.push({ op, ok: true, tx: command.tx, occupancy });
          break;
        }
        case 'readRemaining': {
          const tx = requireTx(command.tx);
          const remaining = tx.readRemaining(command.workcenter, command.start, command.end);
          results.push({ op, ok: true, tx: command.tx, remaining });
          break;
        }
        case 'insert': {
          const tx = requireTx(command.tx);
          tx.insert({
            order: command.order,
            workcenter: command.workcenter,
            start: command.start,
            end: command.end,
            qty: command.qty,
          });
          results.push({ op, ok: true, tx: command.tx, order: command.order });
          break;
        }
        case 'adjust': {
          const tx = requireTx(command.tx);
          tx.adjust({
            order: command.order,
            workcenter: command.workcenter,
            start: command.start,
            end: command.end,
            qty: command.qty,
          });
          results.push({ op, ok: true, tx: command.tx, order: command.order });
          break;
        }
        case 'cancel': {
          const tx = requireTx(command.tx);
          tx.cancel({ order: command.order });
          results.push({ op, ok: true, tx: command.tx, order: command.order });
          break;
        }
        case 'commit': {
          const tx = requireTx(command.tx);
          const outcome = tx.commit();
          results.push({ op, ...outcome, tx: command.tx });
          break;
        }
        case 'abort': {
          const tx = requireTx(command.tx);
          results.push({ op, ...tx.abort(), tx: command.tx });
          break;
        }
        default:
          results.push({ op, ok: false, error: 'E_UNKNOWN_OP' });
      }
    } catch (err) {
      results.push({ op, ok: false, error: 'E_INVALID', message: err.message });
    }
  }
  return results;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const plan = JSON.parse(readInput(process.argv));
    const results = runPlan(plan);
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}
