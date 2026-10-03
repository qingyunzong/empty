import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walstore-'));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference model: a plain Map plus a full snapshot history indexed by txn.
export class Model {
  constructor() {
    this.snapshots = [new Map()]; // snapshots[txn] -> Map(key -> {value, deviceId})
  }

  apply({ key, deviceId = null, value = null, op = 'set' }) {
    const next = new Map(this.snapshots[this.snapshots.length - 1]);
    if (op === 'set') next.set(key, { value, deviceId });
    else next.delete(key);
    this.snapshots.push(next);
    return next;
  }

  get lastTxn() {
    return this.snapshots.length - 1;
  }

  at(txn) {
    return this.snapshots[txn];
  }

  truncateTo(txn) {
    this.snapshots.length = txn + 1;
  }
}

// Deterministic random change generator.
export function randomChange(rand, keys, devices) {
  const key = keys[Math.floor(rand() * keys.length)];
  if (rand() < 0.2) {
    return { key, op: 'del' };
  }
  const deviceId = devices[Math.floor(rand() * devices.length)];
  const value = { reading: Math.floor(rand() * 10000) / 100, unit: 'V', seq: Math.floor(rand() * 1e6) };
  return { key, op: 'set', deviceId, value };
}

export function stateToComparable(state) {
  const obj = {};
  for (const [key, entry] of [...state.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    obj[key] = entry;
  }
  return obj;
}
