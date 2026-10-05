import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from '../src/crc32.js';

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'mledger-'));
}

// Independent enumeration: parse the chunk framing from scratch (no shared
// decoder code) and fold record effects into balances.
export function enumerateBalances(dir) {
  const buf = readFileSync(join(dir, 'events.log'));
  const balances = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const magic = buf.toString('ascii', pos, pos + 4);
    if (magic !== 'MLC1') throw new Error(`bad magic at ${pos}`);
    const length = buf.readUInt32LE(pos + 4);
    const crc = buf.readUInt32LE(pos + 8);
    const payload = buf.subarray(pos + 12, pos + 12 + length);
    if (crc32(payload) !== crc) throw new Error(`crc mismatch at ${pos}`);
    const { records } = JSON.parse(payload.toString('utf8'));
    for (const record of records) {
      for (const effect of record.effects ?? []) {
        const entry = balances.get(effect.batch) ?? { onHand: 0, reserved: 0 };
        entry.onHand += effect.onHand ?? 0;
        entry.reserved += effect.reserved ?? 0;
        balances.set(effect.batch, entry);
      }
    }
    pos += 12 + length;
  }
  return balances;
}

export function balancesOf(status) {
  const out = {};
  for (const [name, batch] of Object.entries(status.batches)) {
    out[name] = { onHand: batch.onHand, reserved: batch.reserved };
  }
  return out;
}
