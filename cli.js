#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  Replica,
  diffSnapshots,
  normalizeRemoteState,
} from './src/replica.js';
import { ApiError } from './src/errors.js';

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(code, extra) {
  out({ error: code, ...(extra || {}) });
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new ApiError('usage', { file });
  }
}

const [cmd, ...args] = process.argv.slice(2);

try {
  switch (cmd) {
    case 'upsert': {
      const [file, id, a, b] = args;
      const amountA = Number(a);
      const amountB = Number(b);
      if (!file || !id || !Number.isFinite(amountA) || !Number.isFinite(amountB)) fail('usage');
      const replica = Replica.load(file);
      replica.upsert(id, amountA, amountB);
      replica.save(file);
      out({ ok: true, id, epoch: replica.epoch(), digest: replica.digest() });
      break;
    }
    case 'resolve': {
      const [file, id] = args;
      if (!file || !id) fail('usage');
      const replica = Replica.load(file);
      replica.resolve(id);
      replica.save(file);
      out({ ok: true, id, status: 'resolved', epoch: replica.epoch(), digest: replica.digest() });
      break;
    }
    case 'delete': {
      const [file, id] = args;
      if (!file || !id) fail('usage');
      const replica = Replica.load(file);
      replica.delete(id);
      replica.save(file);
      out({ ok: true, id, tombstone: true, epoch: replica.epoch(), digest: replica.digest() });
      break;
    }
    case 'snapshot': {
      const [file] = args;
      if (!file) fail('usage');
      out(Replica.load(file).snapshot());
      break;
    }
    case 'diff': {
      const [file, snapshotFile] = args;
      if (!file || !snapshotFile) fail('usage');
      const local = Replica.load(file).snapshot();
      const remote = readJson(snapshotFile);
      out(diffSnapshots(local, remote));
      break;
    }
    case 'merge': {
      const [file, remoteFile] = args;
      if (!file || !remoteFile) fail('usage');
      const replica = Replica.load(file);
      const remote = normalizeRemoteState(readJson(remoteFile));
      const applied = replica.merge(remote);
      replica.save(file);
      if (applied.stale.length > 0) {
        fail('stale-resurrect', { ids: applied.stale });
      }
      const conflicts = replica.conflictList();
      out({
        status: conflicts.length > 0 ? 'conflict' : 'ok',
        applied,
        conflicts,
        epoch: replica.epoch(),
        digest: replica.digest(),
      });
      break;
    }
    default:
      fail('usage');
  }
} catch (err) {
  if (err instanceof ApiError) fail(err.code, err.extra);
  if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) fail('usage');
  throw err;
}
