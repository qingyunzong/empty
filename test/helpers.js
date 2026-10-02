import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEADER, RECORD_TYPE, decodeBlock, decodeIndex } from '../src/format.js';

export function tmpLogPath(name = 'test.evl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-'));
  return path.join(dir, name);
}

// Scans all blocks straight from the file bytes, stopping at the tail index.
export function scanBlocks(file) {
  const buf = fs.readFileSync(file);
  const decoded = decodeIndex(buf);
  const limit = decoded ? decoded.indexStart : buf.length;
  const blocks = [];
  let offset = HEADER.length;
  while (offset < limit) {
    const block = decodeBlock(buf, offset);
    blocks.push({ offset, ...block });
    offset += block.size;
  }
  return blocks;
}

// Hand-rolled line-by-line fold used as the reference implementation in
// tests: baseline events, then corrections and tombstones folded by seq.
export function manualFold(file) {
  const events = new Map();
  const corrections = new Map();
  const tombstones = new Set();
  for (const block of scanBlocks(file)) {
    for (const rec of block.records) {
      if (rec.type === RECORD_TYPE.EVENT) {
        events.set(rec.seq, rec);
      } else if (rec.type === RECORD_TYPE.CORRECTION) {
        const list = corrections.get(rec.refSeq) ?? [];
        list.push(rec);
        corrections.set(rec.refSeq, list);
      } else if (rec.type === RECORD_TYPE.TOMBSTONE) {
        tombstones.add(rec.refSeq);
      }
    }
  }
  const view = [];
  for (const seq of [...events.keys()].sort((a, b) => a - b)) {
    if (tombstones.has(seq)) continue;
    const ev = events.get(seq);
    const record = {
      seq,
      ts: ev.ts,
      device: ev.device,
      status: ev.status,
      payload: ev.payload.toString('utf8'),
      corrected: false,
      correctedBy: null,
    };
    for (const corr of corrections.get(seq) ?? []) {
      if (corr.device !== undefined) record.device = corr.device;
      if (corr.status !== undefined) record.status = corr.status;
      if (corr.payload !== undefined) record.payload = corr.payload.toString('utf8');
      record.corrected = true;
      record.correctedBy = corr.seq;
    }
    view.push(record);
  }
  return view;
}
