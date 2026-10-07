import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Frac } from './frac.js';
import { Ledger } from './ledger.js';
import { LedgerError } from './errors.js';

const C_PREFIX = 'sha256:';

function checksumLine(recordLine) {
  return C_PREFIX + createHash('sha256').update(recordLine, 'utf8').digest('hex');
}

// Append-only log. Each record is two lines:
//   <json>
//   sha256:<hex of the json line>
// The defined fault point is "record written, checksum line not written"
// (or a torn/corrupt checksum). recover() truncates the file back to the
// most recent complete checksum pair and reports a recovery summary.
export class Store {
  constructor(path) {
    this.path = path;
  }

  init(limit) {
    const frac = limit instanceof Frac ? limit : Frac.parse(limit);
    try {
      fs.writeFileSync(this.path, '');
    } catch (e) {
      throw new LedgerError('E_IO', `cannot init ${this.path}: ${e.message}`);
    }
    this.append({ type: 'init', limit: frac.toString() });
  }

  append(record) {
    const line = JSON.stringify(record);
    try {
      fs.appendFileSync(this.path, line + '\n' + checksumLine(line) + '\n');
    } catch (e) {
      throw new LedgerError('E_IO', `cannot append to ${this.path}: ${e.message}`);
    }
  }

  // Returns { exists, records, truncated, validRecords, droppedBytes, droppedLines }.
  // Truncates the file to the last complete record+checksum pair.
  recover() {
    let buf;
    try {
      buf = fs.readFileSync(this.path);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return { exists: false, records: [], truncated: false, validRecords: 0, droppedBytes: 0, droppedLines: 0 };
      }
      throw new LedgerError('E_IO', `cannot read ${this.path}: ${e.message}`);
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const offsets = [];
    let off = 0;
    for (const l of lines) {
      offsets.push(off);
      off += Buffer.byteLength(l, 'utf8') + 1;
    }

    const records = [];
    let validEnd = 0;
    let i = 0;
    while (i < lines.length) {
      if (lines[i] === '' && i === lines.length - 1) {
        validEnd = offsets[i]; // clean EOF after final newline
        break;
      }
      const rec = lines[i];
      const cks = i + 1 < lines.length ? lines[i + 1] : undefined;
      let parsed = null;
      try {
        parsed = JSON.parse(rec);
      } catch {
        parsed = null;
      }
      if (parsed !== null && cks === checksumLine(rec)) {
        records.push(parsed);
        validEnd = offsets[i + 1] + Buffer.byteLength(cks, 'utf8') + 1;
        i += 2;
      } else {
        break; // fault point: orphan record or bad/missing checksum
      }
    }

    const truncated = validEnd < buf.length;
    let droppedLines = 0;
    if (truncated) {
      droppedLines = text.slice(0, validEnd) === text ? 0 : lines.length - i;
      try {
        fs.writeFileSync(this.path, buf.subarray(0, validEnd));
      } catch (e) {
        throw new LedgerError('E_IO', `cannot truncate ${this.path}: ${e.message}`);
      }
    }
    return {
      exists: true,
      records,
      truncated,
      validRecords: records.length,
      droppedBytes: buf.length - validEnd,
      droppedLines,
    };
  }
}

// Recover + replay the whole log into a Ledger.
export function loadLedger(store) {
  const summary = store.recover();
  if (summary.records.length === 0) {
    throw new LedgerError('E_IO', `log ${store.path} is empty or missing; run "init" first`);
  }
  const [init, ...ops] = summary.records;
  if (init.type !== 'init' || typeof init.limit !== 'string') {
    throw new LedgerError('E_PARSE', 'first record must be an init record');
  }
  const ledger = new Ledger(Frac.parse(init.limit));
  for (const op of ops) ledger.apply(op);
  return { ledger, summary };
}
