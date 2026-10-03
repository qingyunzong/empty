import fs from 'node:fs';
import { CODES, LogError } from './errors.js';

// Minimal durable-storage interface used by the log:
//   size() -> number
//   read(offset, len) -> Buffer (may be short at EOF)
//   write(offset, buf)
//   fsync()                 durability barrier / commit point
//   truncate(size)
//   close()
// Tests substitute an in-memory implementation with crash simulation.

export class FileStorage {
  constructor(filePath, { readonly = false } = {}) {
    this.path = filePath;
    this.readonly = readonly;
    try {
      if (readonly) {
        this.fd = fs.existsSync(filePath) ? fs.openSync(filePath, 'r') : null;
      } else {
        this.fd = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
      }
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
        throw new LogError(CODES.READONLY, `cannot open ${filePath}: ${err.code}`);
      }
      throw err;
    }
  }

  size() {
    return this.fd == null ? 0 : fs.fstatSync(this.fd).size;
  }

  read(offset, len) {
    if (this.fd == null) return Buffer.alloc(0);
    const buf = Buffer.alloc(len);
    const n = fs.readSync(this.fd, buf, 0, len, offset);
    return buf.subarray(0, n);
  }

  write(offset, buf) {
    if (this.readonly) {
      throw new LogError(CODES.READONLY, 'log is read-only');
    }
    fs.writeSync(this.fd, buf, 0, buf.length, offset);
  }

  fsync() {
    if (this.fd != null && !this.readonly) fs.fsyncSync(this.fd);
  }

  truncate(size) {
    if (this.readonly) {
      throw new LogError(CODES.READONLY, 'log is read-only');
    }
    fs.ftruncateSync(this.fd, size);
  }

  close() {
    if (this.fd != null) fs.closeSync(this.fd);
    this.fd = null;
  }
}
