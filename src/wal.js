import fs from 'node:fs';
import { ioError } from './errors.js';

export class Wal {
  constructor(fd, path, seq) {
    this.fd = fd;
    this.path = path;
    this.seq = seq;
  }

  static create(path, header) {
    let fd;
    try {
      fd = fs.openSync(path, 'wx');
    } catch (e) {
      throw ioError(`cannot create WAL ${path}: ${e.message}`);
    }
    const wal = new Wal(fd, path, 0);
    wal.writeRaw({ ...header, type: 'header' });
    return wal;
  }

  static append(path) {
    const { records } = Wal.read(path);
    let fd;
    try {
      fd = fs.openSync(path, 'a');
    } catch (e) {
      throw ioError(`cannot open WAL ${path}: ${e.message}`);
    }
    return new Wal(fd, path, records.length);
  }

  static read(path) {
    let text;
    try {
      text = fs.readFileSync(path, 'utf8');
    } catch (e) {
      throw ioError(`cannot read WAL ${path}: ${e.message}`);
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw ioError(`WAL ${path} is empty`);
    let header = null;
    const records = [];
    lines.forEach((line, i) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        throw ioError(`corrupt WAL ${path} at line ${i + 1}`);
      }
      if (i === 0 && rec.type === 'header') header = rec;
      else records.push(rec);
    });
    if (!header) throw ioError(`WAL ${path} is missing its header record`);
    return { header, records };
  }

  append(record) {
    this.seq += 1;
    const rec = { seq: this.seq, ...record };
    this.writeRaw(rec);
    return rec;
  }

  writeRaw(rec) {
    try {
      fs.writeSync(this.fd, `${JSON.stringify(rec)}\n`);
      fs.fsyncSync(this.fd);
    } catch (e) {
      throw ioError(`WAL write failed on ${this.path}: ${e.message}`);
    }
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}
