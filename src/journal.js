// Savepoint-layered write-ahead journal.
//
// Every JSONL record is fsync'd before the next one is written, so the
// crash recovery point is exactly the last fully-fsync'd record. A layer is
//   begin -> batch*/meta* -> commit
// and only committed (complete) layers are replayed on recovery; a torn
// tail (partial final line, or an uncommitted layer) is discarded.

import fs from 'node:fs';
import { LayerHoleError } from './errors.js';

export function appendRecord(path, obj) {
  const fd = fs.openSync(path, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(obj)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJournal(path) {
  if (!fs.existsSync(path)) {
    return { entries: [], layers: [], recoveredTo: 0, discardedTail: false, tornOffset: null };
  }
  const text = fs.readFileSync(path, 'utf8');
  const entries = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      const line = text.slice(start, i);
      if (line.trim().length > 0) entries.push({ offset: start, obj: JSON.parse(line) });
      start = i + 1;
    }
  }
  const discardedTail = start < text.length;

  const layers = [];
  let open = null;
  for (const { obj } of entries) {
    if (obj.type === 'begin') {
      const expected = layers.length + 1;
      if (obj.layer !== expected) {
        throw new LayerHoleError(
          `journal layer hole: expected layer ${expected}, found layer ${obj.layer}`,
        );
      }
      open = { layer: obj.layer, records: [] };
    } else if (obj.type === 'commit') {
      if (open !== null && obj.layer === open.layer) {
        layers.push(open);
        open = null;
      }
    } else if (open !== null && obj.layer === open.layer) {
      open.records.push(obj);
    }
  }
  return {
    entries,
    layers,
    recoveredTo: layers.length,
    discardedTail,
    tornOffset: discardedTail ? start : null,
  };
}

// Crash recovery self-healing: drop a torn partial tail so future appends
// start exactly after the last fully-fsync'd record.
export function truncateTornTail(path, tornOffset) {
  const fd = fs.openSync(path, 'r+');
  try {
    fs.ftruncateSync(fd, tornOffset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Drop every record belonging to layers > keepLayers by truncating the file
// at the byte offset where the first dropped record starts, then fsync.
export function truncateJournal(path, keepLayers) {
  if (!fs.existsSync(path)) return;
  const text = fs.readFileSync(path, 'utf8');
  let cut = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      const line = text.slice(start, i);
      if (line.trim().length > 0) {
        let obj = null;
        try {
          obj = JSON.parse(line);
        } catch {
          obj = null; // torn tail: drop it too
        }
        if (obj !== null && typeof obj.layer === 'number' && obj.layer > keepLayers) break;
      }
      cut = Math.min(i + 1, text.length);
      start = i + 1;
    }
  }
  const fd = fs.openSync(path, 'r+');
  try {
    fs.ftruncateSync(fd, cut);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
