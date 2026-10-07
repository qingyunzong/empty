import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function tmpDir(prefix = 'labelpack-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const WS_MULTIBYTE = '包装线α-①😀'; // CJK + Greek + circled digit + emoji
export const GTIN_A = '06901234567890';
export const GTIN_B = '06912345678903';
export const BATCH_A = 'L2026-01';
export const BATCH_B = '批号-β②';

export function sampleLabels() {
  return [
    { gtin: GTIN_A, batch: BATCH_A, serial: 'SN-0001', workstation: WS_MULTIBYTE, timestamp: '2026-10-07T08:00:00Z' },
    { gtin: GTIN_A, batch: BATCH_A, serial: 'SN-0002', workstation: WS_MULTIBYTE, timestamp: '2026-10-07T08:00:01.500Z' },
    { gtin: GTIN_B, batch: BATCH_B, serial: '序列-③', workstation: WS_MULTIBYTE, timestamp: 1790000002500 },
  ];
}

export function sampleDictValues() {
  return { gtin: [GTIN_A, GTIN_B], batch: [BATCH_A, BATCH_B], workstation: [WS_MULTIBYTE] };
}

// Independent normalized enumeration used as the acceptance oracle.
export function expectedNormalized() {
  return [
    { gtin: '06901234567890', batch: 'L2026-01', serial: 'SN-0001', workstation: '包装线α-①😀', timestamp: '2026-10-07T08:00:00.000Z' },
    { gtin: '06901234567890', batch: 'L2026-01', serial: 'SN-0002', workstation: '包装线α-①😀', timestamp: '2026-10-07T08:00:01.500Z' },
    { gtin: '06912345678903', batch: '批号-β②', serial: '序列-③', workstation: '包装线α-①😀', timestamp: '2026-09-21T14:13:22.500Z' },
  ];
}

// Flips one byte inside the payload of the block at `entry` (from readIndex).
export function corruptBlockPayload(dir, entry, payloadOffset = 0) {
  const file = path.join(dir, 'labels.plp');
  const fd = fs.openSync(file, 'r+');
  try {
    const pos = entry.offset + 9 + payloadOffset; // skip 9-byte block header
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, pos);
    buf[0] ^= 0xff;
    fs.writeSync(fd, buf, 0, 1, pos);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
