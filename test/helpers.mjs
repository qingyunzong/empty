import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-trace-'));
}

let n = 0;
export function ev(over = {}) {
  n++;
  return {
    id: over.id ?? `e${n}`,
    ts: over.ts ?? n * 1000,
    device: over.device ?? 'PLC1',
    lot: over.lot ?? 'L1',
    kind: over.kind ?? 'quality.scan',
    payload: over.payload ?? { result: 'pass', qty: 1 },
  };
}

export function resetIds() {
  n = 0;
}
