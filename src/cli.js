#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { WalError, InjectedCrashError, ExitCode } from './errors.js';

function stateToObject(state) {
  const obj = {};
  for (const [key, entry] of [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    obj[key] = entry;
  }
  return obj;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function fail(err) {
  if (err instanceof WalError) {
    process.stderr.write(`ERROR ${err.code}: ${err.message}\n`);
    process.exitCode = ExitCode[err.code] ?? ExitCode.USAGE;
    return;
  }
  if (err instanceof InjectedCrashError) {
    process.stderr.write(`INJECTED_CRASH at ${err.point} (txn ${err.txn})\n`);
    process.exitCode = ExitCode.INJECTED_CRASH;
    return;
  }
  process.stderr.write(`ERROR: ${err.message}\n`);
  process.exitCode = ExitCode.USAGE;
}

const USAGE = `walstore - WAL-centric auditable measurement store

Usage: walstore [--data DIR] <command> [options]

Commands:
  apply --key K --device D --value V   set key K to JSON value V (one txn)
  apply --key K --delete               delete key K (one txn)
    [--inject after-write|after-fsync] simulate a crash at the given point
  replay --to N                        rebuild full state at txn N (N=0: empty)
  audit                                diff index.json against full WAL replay
  checkpoint                           snapshot current state as a checkpoint
  inject truncate --offset N           physically truncate wal.log at byte N
  inject corrupt-byte --offset N       flip one byte at offset N

Exit codes: 0 ok, 1 usage/io, 2 NO_SUCH_TXN, 3 CHECKSUM_MISMATCH,
            4 AUDIT_DIVERGENCE, 75 INJECTED_CRASH
`;

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: 'string', default: process.env.WALSTORE_DIR ?? 'walstore-data' },
      key: { type: 'string' },
      device: { type: 'string' },
      value: { type: 'string' },
      delete: { type: 'boolean', default: false },
      to: { type: 'string' },
      offset: { type: 'string' },
      inject: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, sub] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? ExitCode.OK : ExitCode.USAGE;
  }
  const dir = path.resolve(values.data);

  if (command === 'inject') {
    const walPath = path.join(dir, 'wal.log');
    const offset = Number(values.offset);
    if (!Number.isInteger(offset) || offset < 0) throw new WalError('USAGE', 'inject requires --offset N');
    if (sub === 'truncate') {
      fs.truncateSync(walPath, offset);
      process.stdout.write(JSON.stringify({ truncated: true, offset }) + '\n');
      return ExitCode.OK;
    }
    if (sub === 'corrupt-byte') {
      const fd = fs.openSync(walPath, 'r+');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, offset);
      buf[0] ^= 0xff;
      fs.writeSync(fd, buf, 0, 1, offset);
      fs.closeSync(fd);
      process.stdout.write(JSON.stringify({ corrupted: true, offset }) + '\n');
      return ExitCode.OK;
    }
    throw new WalError('USAGE', `unknown inject subcommand: ${sub}`);
  }

  const needsRecovery = command === 'apply' || command === 'checkpoint';
  const store = Store.open(dir, { recover: needsRecovery });
  try {
    if (store.recovery) {
      process.stderr.write(
        `RECOVERY: truncated WAL at offset ${store.recovery.truncatedAt} ` +
          `(${store.recovery.reason}, dropped ${store.recovery.droppedBytes} bytes)\n`,
      );
    }
    switch (command) {
      case 'apply': {
        if (!values.key) throw new WalError('USAGE', 'apply requires --key');
        const change = values.delete
          ? { key: values.key, op: 'del' }
          : { key: values.key, op: 'set', deviceId: values.device, value: parseValue(values.value ?? 'null') };
        const record = store.apply(change, { inject: values.inject ?? null });
        process.stdout.write(JSON.stringify({ applied: record }) + '\n');
        return ExitCode.OK;
      }
      case 'replay': {
        const to = Number(values.to);
        if (values.to === undefined || !Number.isInteger(to)) throw new WalError('USAGE', 'replay requires --to N');
        const state = store.replay(to);
        process.stdout.write(JSON.stringify({ txn: to, state: stateToObject(state) }) + '\n');
        return ExitCode.OK;
      }
      case 'audit': {
        const report = store.audit();
        process.stdout.write(JSON.stringify(report) + '\n');
        return report.ok ? ExitCode.OK : ExitCode.AUDIT_DIVERGENCE;
      }
      case 'checkpoint': {
        const snapshot = store.checkpoint();
        process.stdout.write(JSON.stringify({ checkpoint: { txn: snapshot.txn, keys: snapshot.state.length } }) + '\n');
        return ExitCode.OK;
      }
      default:
        throw new WalError('USAGE', `unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  fail(err);
}
