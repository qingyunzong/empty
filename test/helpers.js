import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../src/archive.js';
import { EventLog } from '../src/eventlog.js';

export const T0 = Date.parse('2024-01-01T00:00:00Z');
export const HOUR = 3600_000;
export const iso = (h) => new Date(T0 + h * HOUR).toISOString();

export async function freshDir() {
  return mkdtemp(join(tmpdir(), 'wxa-test-'));
}

export async function openArchive(opts) {
  const dir = await freshDir();
  const archive = await Archive.open(dir, opts);
  return { dir, archive };
}

export async function readEvents(dir) {
  const verified = await EventLog.readVerified(join(dir, 'events.log'));
  return verified.events;
}

export function assertClose(actual, expected, eps = 1e-9) {
  if (actual === null || expected === null) {
    if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
    return;
  }
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`expected ~${expected}, got ${actual}`);
  }
}
