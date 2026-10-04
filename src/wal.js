import { openSync, readSync, writeSync, fsyncSync, fstatSync, ftruncateSync, closeSync } from 'node:fs';

// Append-only write-ahead log. One JSON record per line.
// Every append is fsync'd before returning, so a committed record
// survives a process crash. Torn tails (partial last line) are
// truncated on open.
export class Wal {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'a+');
    this.records = [];
    this.#recover();
  }

  #recover() {
    const size = fstatSync(this.fd).size;
    if (size === 0) return;
    const buf = Buffer.alloc(size);
    readSync(this.fd, buf, 0, size, 0);
    let offset = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (line === '') {
        offset += 1;
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        break; // torn tail: stop and truncate below
      }
      this.records.push(record);
      offset += Buffer.byteLength(line) + 1;
    }
    if (offset < size) ftruncateSync(this.fd, offset);
  }

  append(record) {
    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    writeSync(this.fd, line, 0, line.length);
    fsyncSync(this.fd);
    this.records.push(record);
    return record;
  }

  all() {
    return this.records;
  }

  close() {
    closeSync(this.fd);
  }
}
