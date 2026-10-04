// Append-only JSONL event log with crash recovery.
// append() writes one line and fsyncs (unless sync:false for testing).
// recover() tolerates a crash mid-write: a torn trailing line (missing
// newline or unparseable JSON) is truncated and the log is repaired in place.

import fs from 'node:fs';

export class EventLog {
  constructor(path) {
    this.path = path;
    this.fd = null;
  }

  // Recovers any torn tail, then opens for appending. Returns recovery info.
  open() {
    const info = EventLog.recover(this.path);
    this.fd = fs.openSync(this.path, 'a');
    return info;
  }

  append(record, { sync = true } = {}) {
    if (this.fd === null) throw new Error('log not open');
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    if (sync) fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  // Reads complete, valid lines. On a torn/invalid tail, truncates the file
  // to the last good offset. Returns { events, repaired, truncatedBytes }.
  static recover(path) {
    if (!fs.existsSync(path)) return { events: [], repaired: false, truncatedBytes: 0 };
    const buf = fs.readFileSync(path);
    const events = [];
    let offset = 0; // byte offset just past the last good line
    let repaired = false;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset); // '\n'
      if (nl === -1) { repaired = true; break; } // torn tail: no newline
      const line = buf.subarray(offset, nl).toString('utf8');
      try {
        events.push(JSON.parse(line));
      } catch {
        repaired = true;
        break;
      }
      offset = nl + 1;
    }
    let truncatedBytes = 0;
    if (repaired) {
      truncatedBytes = buf.length - offset;
      fs.truncateSync(path, offset);
    }
    return { events, repaired, truncatedBytes };
  }
}
