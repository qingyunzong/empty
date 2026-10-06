// Append-only store. Each record is two lines:
//   <json record>\n
//   #<sha256-of-record-line>\n
// Fault model: a crash may leave a record line whose checksum line was never
// (fully) written. On open we truncate back to the last complete
// record+checksum pair and report a recovery summary.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { AppError, E_IO } from './engine.js';

function checksum(line) {
  return '#' + crypto.createHash('sha256').update(line, 'utf8').digest('hex');
}

export class Store {
  constructor(path) { this.path = path; }

  // Returns {store, records, recovery:{intactRecords, droppedRecords, bytesRemoved}}
  static open(path) {
    let buf;
    try {
      if (!fs.existsSync(path)) fs.writeFileSync(path, '');
      buf = fs.readFileSync(path);
    } catch (e) {
      throw new AppError(E_IO, `cannot open store ${path}: ${e.message}`);
    }
    const text = buf.toString('utf8');
    const rawLines = text.split('\n');
    const lines = []; // {text, offset, end} end = offset past line incl. newline
    let off = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const t = rawLines[i];
      const len = Buffer.byteLength(t) + (i < rawLines.length - 1 ? 1 : 0);
      lines.push({ text: t, offset: off, end: off + len });
      off += len;
    }
    const records = [];
    let goodEnd = 0, i = 0;
    while (i < lines.length) {
      const L = lines[i];
      if (L.text === '') { i++; continue; } // trailing newline artifact
      if (!L.text.startsWith('{')) break;   // corrupt tail
      const C = lines[i + 1];
      if (!C || C.text !== checksum(L.text)) break; // crash point: record without checksum
      try {
        records.push(JSON.parse(L.text));
      } catch {
        break; // hash matched but unparseable: treat as corruption boundary
      }
      goodEnd = C.end;
      i += 2;
    }
    const droppedRecords = lines.slice(i).filter((l) => l.text.startsWith('{')).length;
    const bytesRemoved = buf.length - goodEnd;
    if (bytesRemoved > 0) {
      try { fs.truncateSync(path, goodEnd); }
      catch (e) { throw new AppError(E_IO, `cannot truncate store ${path}: ${e.message}`); }
    }
    return {
      store: new Store(path),
      records,
      recovery: { intactRecords: records.length, droppedRecords, bytesRemoved },
    };
  }

  append(record) {
    const line = JSON.stringify(record);
    try {
      fs.appendFileSync(this.path, line + '\n' + checksum(line) + '\n');
    } catch (e) {
      throw new AppError(E_IO, `cannot append to store ${this.path}: ${e.message}`);
    }
  }
}
