#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { MvccStore, StoreError } from './src/store.js';

const store = new MvccStore();
const snapshots = new Map();
let nextSnapshotId = 1;
let exitCode = 0;

function markDomainError() {
  if (exitCode < 1) exitCode = 1;
}

function markUsageError() {
  exitCode = 2;
}

function resolveSnapshot(cmd) {
  if (cmd.snapshot === undefined || cmd.snapshot === null) return null;
  const snap = snapshots.get(cmd.snapshot);
  if (!snap) throw new StoreError('E_INVAL', `unknown snapshot: ${cmd.snapshot}`);
  return snap;
}

function usageError(message) {
  const err = new StoreError('E_USAGE', message);
  err.usage = true;
  return err;
}

function runCommand(cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw usageError('command must be a JSON object');
  }
  switch (cmd.op) {
    case 'insert':
      return store.insert(cmd);
    case 'correct':
      return store.correct(cmd.eventId, cmd);
    case 'delete':
      return store.delete(cmd.eventId);
    case 'snapshot': {
      const id = nextSnapshotId++;
      snapshots.set(id, store.snapshot());
      return { snapshot: id, txAt: store.currentTx };
    }
    case 'get': {
      const snap = resolveSnapshot(cmd);
      return snap ? snap.get(cmd.eventId) : store.get(cmd.eventId);
    }
    case 'range': {
      const snap = resolveSnapshot(cmd);
      return snap
        ? snap.range(cmd.deviceId, cmd.from, cmd.to)
        : store.range(cmd.deviceId, cmd.from, cmd.to);
    }
    default:
      throw usageError(`unknown op: ${String(cmd.op)}`);
  }
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch {
    markUsageError();
    writeLine({ ok: false, error: { code: 'E_PARSE', message: 'invalid JSON line' } });
    continue;
  }
  try {
    writeLine({ ok: true, result: runCommand(cmd) });
  } catch (err) {
    if (err instanceof StoreError) {
      if (err.usage) markUsageError();
      else markDomainError();
      writeLine({ ok: false, error: { code: err.code, message: err.message } });
    } else {
      markUsageError();
      writeLine({ ok: false, error: { code: 'E_INTERNAL', message: String(err && err.message || err) } });
    }
  }
}
process.exitCode = exitCode;
