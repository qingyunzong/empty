import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';
import { err, CODES } from './errors.js';
import { canonicalJson, hashValue } from './canon.js';

export const MAGIC = Buffer.from('SCHJ');
const HEADER = 12; // magic(4) + len(4) + crc(4)

export function encodeChunk(payloadObj) {
  const payload = Buffer.from(canonicalJson(payloadObj), 'utf8');
  const head = Buffer.alloc(HEADER);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(payload.length, 4);
  head.writeUInt32LE(crc32(payload), 8);
  return Buffer.concat([head, payload]);
}

// Parse all chunks in buf starting at `from`. Never throws; reports corruption.
export function scanChunks(buf, from = 0) {
  const chunks = [];
  let offset = from;
  while (offset < buf.length) {
    if (offset + HEADER > buf.length) {
      return { chunks, corruptAt: offset, reason: 'truncated header' };
    }
    if (!buf.subarray(offset, offset + 4).equals(MAGIC)) {
      return { chunks, corruptAt: offset, reason: 'bad magic' };
    }
    const len = buf.readUInt32LE(offset + 4);
    const crc = buf.readUInt32LE(offset + 8);
    const end = offset + HEADER + len;
    if (end > buf.length) {
      return { chunks, corruptAt: offset, reason: 'truncated payload' };
    }
    const payload = buf.subarray(offset + HEADER, end);
    if (crc32(payload) !== crc) {
      return { chunks, corruptAt: offset, reason: 'crc mismatch', declaredEnd: end };
    }
    let record;
    try {
      record = JSON.parse(payload.toString('utf8'));
    } catch {
      return { chunks, corruptAt: offset, reason: 'bad json', declaredEnd: end };
    }
    chunks.push({ offset, end, record });
    offset = end;
  }
  return { chunks, corruptAt: null };
}

export class Journal {
  constructor(dir, { snapshotEvery = 4 } = {}) {
    this.dir = dir;
    this.logPath = path.join(dir, 'journal.log');
    this.snapDir = path.join(dir, 'snapshots');
    this.indexPath = path.join(this.snapDir, 'index.json');
    this.snapshotEvery = snapshotEvery;
    this.records = [];   // all valid commit records in order
    this.state = null;   // set by caller via replay hook
    this.baseOffset = 0; // log offset covered by the loaded snapshot
    this.recovered = false;
  }

  static init(dir, opts) {
    fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
    const j = new Journal(dir, opts);
    if (!fs.existsSync(j.logPath)) fs.writeFileSync(j.logPath, Buffer.alloc(0));
    if (!fs.existsSync(j.indexPath)) {
      fs.writeFileSync(j.indexPath, JSON.stringify({ snapshots: [] }, null, 2));
    }
    return j;
  }

  static exists(dir) {
    return fs.existsSync(path.join(dir, 'journal.log'));
  }

  readIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch {
      return { snapshots: [] };
    }
  }

  // Returns { snapshot, entry } for the newest valid snapshot, or null.
  loadLatestSnapshot() {
    const index = this.readIndex();
    for (let i = index.snapshots.length - 1; i >= 0; i--) {
      const entry = index.snapshots[i];
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(this.snapDir, entry.file), 'utf8'));
        if (hashValue(snap.state) !== snap.stateHash) continue; // skip corrupt snapshot
        return { snapshot: snap, entry };
      } catch {
        continue;
      }
    }
    return null;
  }

  // Scan the whole journal from offset 0. Tolerant mode truncates a corrupt
  // tail; a corrupt chunk followed by more valid chunks is fatal (E_CRC).
  // The newest snapshot consistent with the surviving records is selected
  // via acceptSnapshot(snap, chunks); older snapshots are fallbacks.
  load({ strict = false, acceptSnapshot } = {}) {
    const buf = fs.existsSync(this.logPath) ? fs.readFileSync(this.logPath) : Buffer.alloc(0);
    const { chunks, corruptAt, reason, declaredEnd } = scanChunks(buf, 0);
    this.records = chunks;
    this.recovered = false;

    if (corruptAt !== null) {
      const tailOnly = declaredEnd === undefined || declaredEnd >= buf.length
        || scanChunks(buf, declaredEnd).chunks.length === 0;
      if (strict || !tailOnly) {
        throw err(CODES.E_CRC, `journal corrupt at offset ${corruptAt}: ${reason}`);
      }
      // Tolerate a torn/corrupt tail: drop it so future appends overwrite it.
      fs.truncateSync(this.logPath, corruptAt);
      this.recovered = true;
    }

    let chosen = null;
    const index = this.readIndex();
    for (let i = index.snapshots.length - 1; i >= 0 && !chosen; i--) {
      const entry = index.snapshots[i];
      let snap;
      try {
        snap = JSON.parse(fs.readFileSync(path.join(this.snapDir, entry.file), 'utf8'));
      } catch {
        continue;
      }
      if (hashValue(snap.state) !== snap.stateHash) continue; // corrupt snapshot
      if (snap.logOffset > this.logSize()) continue; // covers truncated-away data
      if (acceptSnapshot && !acceptSnapshot(snap, chunks)) continue;
      chosen = snap;
    }
    this.snapshot = chosen;
    this.baseOffset = chosen?.logOffset ?? 0;
    return { snapshot: this.snapshot, chunks: this.records, recovered: this.recovered };
  }

  append(record) {
    const chunk = encodeChunk(record);
    fs.appendFileSync(this.logPath, chunk);
    return this.logSize();
  }

  logSize() {
    return fs.existsSync(this.logPath) ? fs.statSync(this.logPath).size : 0;
  }

  maybeSnapshot(seq, state, tipHash, force = false) {
    if (!force && seq % this.snapshotEvery !== 0) return null;
    return this.writeSnapshot(seq, state, tipHash);
  }

  writeSnapshot(seq, state, tipHash) {
    const stateHash = hashValue(state);
    const file = `snap-${String(seq).padStart(8, '0')}.json`;
    const snap = { v: 1, seq, tipHash, logOffset: this.logSize(), stateHash, state };
    fs.mkdirSync(this.snapDir, { recursive: true });
    fs.writeFileSync(path.join(this.snapDir, file), JSON.stringify(snap, null, 2));
    const index = this.readIndex();
    index.snapshots = index.snapshots.filter((e) => e.seq !== seq);
    index.snapshots.push({ seq, logOffset: snap.logOffset, file, stateHash });
    index.snapshots.sort((a, b) => a.seq - b.seq);
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    return { seq, stateHash, logOffset: snap.logOffset };
  }
}
