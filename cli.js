#!/usr/bin/env node
import fs from 'node:fs';
import { Engine } from './src/engine.js';
import { ValidationError, parseTime } from './src/model.js';

const USAGE = `Usage: node cli.js <command> <log-file> [options]

Commands:
  append <log> --file batch.json     Validate and atomically commit a batch
                                     ({tx_id, tx_time, events:[{id, equipment,
                                     valid_time, state}]}); prints per-day deltas
  undo <log> --tx <tx_id> [--tx-time ISO]
                                     Revert a committed transaction (append-only
                                     compensating entry); prints per-day deltas
  state <log> --equipment E --valid-time ISO [--tx-time ISO]
                                     State of one equipment at a valid instant,
                                     as of a transaction time (default: now)
  counts <log> [--tx-time ISO]       Daily up/down counts (default: current view)
  hash <log>                         SHA-256 of the current daily-counts snapshot
  verify <log>                       Cross-check incremental state against a full
                                     independent rebuild of the log
`;

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) throw new ValidationError(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ValidationError(`missing value for --${key}`);
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function requireFlag(flags, name) {
  if (flags[name] === undefined) throw new ValidationError(`missing required --${name}`);
  return flags[name];
}

function countsObject(counts) {
  const out = {};
  for (const day of [...counts.keys()].sort()) out[day] = counts.get(day);
  return out;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main(argv) {
  const [command, logPath, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!logPath) throw new ValidationError('missing <log-file> argument');
  const flags = parseFlags(rest);

  switch (command) {
    case 'append': {
      const batch = JSON.parse(fs.readFileSync(requireFlag(flags, 'file'), 'utf8'));
      const engine = Engine.load(logPath);
      const result = engine.commit(batch);
      print({ status: 'committed', tx_id: batch.tx_id, deltas: result.deltas, hash: result.hash });
      return 0;
    }
    case 'undo': {
      const txId = requireFlag(flags, 'tx');
      const engine = Engine.load(logPath);
      const result = engine.revert(txId, flags['tx-time']);
      print({ status: 'reverted', tx_id: txId, deltas: result.deltas, hash: result.hash });
      return 0;
    }
    case 'state': {
      const equipment = requireFlag(flags, 'equipment');
      const validMs = parseTime(requireFlag(flags, 'valid-time'), 'valid_time');
      const engine = Engine.load(logPath);
      let state;
      let asOf;
      if (flags['tx-time'] !== undefined) {
        const txMs = parseTime(flags['tx-time'], 'tx_time');
        state = engine.asOf(txMs).stateAt(equipment, validMs);
        asOf = new Date(txMs).toISOString();
      } else {
        state = engine.stateAt(equipment, validMs);
        asOf = 'now';
      }
      print({
        equipment,
        valid_time: new Date(validMs).toISOString(),
        tx_time: asOf,
        state,
      });
      return 0;
    }
    case 'counts': {
      const engine = Engine.load(logPath);
      if (flags['tx-time'] !== undefined) {
        const txMs = parseTime(flags['tx-time'], 'tx_time');
        print({
          tx_time: new Date(txMs).toISOString(),
          counts: countsObject(engine.asOf(txMs).counts),
        });
      } else {
        print({ tx_time: 'now', counts: countsObject(engine.counts), hash: engine.hash() });
      }
      return 0;
    }
    case 'hash': {
      const engine = Engine.load(logPath);
      print({ hash: engine.hash() });
      return 0;
    }
    case 'verify': {
      const engine = Engine.load(logPath);
      if (engine.verify()) {
        print({ status: 'ok', days: engine.counts.size, hash: engine.hash() });
        return 0;
      }
      print({ status: 'mismatch' });
      return 1;
    }
    default:
      throw new ValidationError(`unknown command: ${command}\n${USAGE}`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ValidationError) {
    print({ status: 'rejected', error: error.message });
    process.exitCode = 1;
  } else {
    throw error;
  }
}
