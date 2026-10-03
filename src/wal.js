import fs from 'node:fs';
import { crc32 } from './crc32.js';
import { CrashError } from './errors.js';

// WAL record layout (one record per committed transaction):
//   magic  'BW'        2 bytes
//   length uint32 LE   4 bytes   (payload length)
//   crc32  uint32 LE   4 bytes   (CRC of payload)
//   payload JSON       <length> bytes  { txid, ts, writes: [[key, value], ...] }
//
// A transaction is durable iff its *entire* commit record is written and
// fsynced. Recovery stops at the first incomplete/corrupt record and
// truncates it, so a torn tail (crash mid-commit) is ignored atomically:
// the account balance and its usage records either both survive or both
// vanish.
const MAGIC = Buffer.from('BW');
const HEADER_LEN = 10;

export class Wal {
  constructor(file) {
    this.file = file;
  }

  // Replay all valid commit records, then truncate any torn/corrupt tail so
  // future appends are not stranded behind unrecoverable bytes.
  static recover(file) {
    const commits = [];
    if (!fs.existsSync(file)) return commits;
    const buf = fs.readFileSync(file);
    let off = 0;
    while (off + HEADER_LEN <= buf.length) {
      if (!buf.subarray(off, off + 2).equals(MAGIC)) break;
      const len = buf.readUInt32LE(off + 2);
      const crc = buf.readUInt32LE(off + 6);
      const start = off + HEADER_LEN;
      if (start + len > buf.length) break; // torn record: incomplete payload
      const payload = buf.subarray(start, start + len);
      if (crc32(payload) !== crc) break; // corrupt payload
      commits.push(JSON.parse(payload.toString('utf8')));
      off = start + len;
    }
    if (off < buf.length) fs.truncateSync(file, off);
    return commits;
  }

  // Append one commit record and fsync. Test hook `crashAfterBytes`:
  // write only that many bytes, fsync, then throw CrashError to simulate a
  // crash mid-commit (use >= record size to crash right after a full write).
  appendCommit(record, { crashAfterBytes = null } = {}) {
    const payload = Buffer.from(JSON.stringify(record), 'utf8');
    const header = Buffer.alloc(HEADER_LEN);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(payload.length, 2);
    header.writeUInt32LE(crc32(payload), 6);
    const full = Buffer.concat([header, payload]);
    const fd = fs.openSync(this.file, 'a');
    try {
      if (crashAfterBytes !== null) {
        fs.writeSync(fd, full.subarray(0, Math.min(crashAfterBytes, full.length)));
        fs.fsyncSync(fd);
        throw new CrashError(`simulated crash after ${Math.min(crashAfterBytes, full.length)} of ${full.length} bytes`);
      }
      fs.writeSync(fd, full);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
