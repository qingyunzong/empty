'use strict';

const fs = require('node:fs');

// CRC-32 (IEEE 802.3, reflected) over a UTF-8 string, hex-encoded.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(str) {
  const buf = Buffer.from(str, 'utf8');
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff).toString(16).padStart(8, '0');
}

class CrcError extends Error {
  constructor(offset) {
    super(`CRC check failed at offset ${offset}: corrupt pack store (not a clean tail)`);
    this.name = 'CrcError';
    this.code = 'CRC_FAILED';
  }
}

// Append-only store. Each record is one JSON line: {crc, data}.
// Recovery: verify the CRC of every record; a corrupt tail (the only
// recoverable case) is truncated so the store returns to the last
// complete record. Corruption followed by further valid-looking records
// is a hard error (CRC_FAILED).
class PackStore {
  constructor(path) {
    this.path = path;
    this.records = [];
    this.packs = new Map(); // name -> {versions: Map, current}
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.path)) return;
    const buf = fs.readFileSync(this.path);
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      const end = nl === -1 ? buf.length : nl + 1;
      const line = buf.subarray(offset, end).toString('utf8').trim();
      if (line === '') {
        offset = end;
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return this._truncateOrThrow(offset);
      }
      if (
        typeof record !== 'object' || record === null ||
        typeof record.crc !== 'string' ||
        record.data === undefined ||
        crc32(JSON.stringify(record.data)) !== record.crc
      ) {
        return this._truncateOrThrow(offset);
      }
      this._apply(record.data);
      offset = end;
    }
  }

  _truncateOrThrow(offset) {
    const rest = fs.readFileSync(this.path).subarray(offset).toString('utf8');
    const lines = rest.split('\n');
    // lines[0] is the bad record. Any further non-empty line means the
    // corruption is mid-file, not a torn tail: that is a hard error.
    if (lines.slice(1).some((l) => l.trim() !== '')) {
      throw new CrcError(offset);
    }
    // Torn tail (e.g. crash mid-append): truncate to the last good record.
    fs.truncateSync(this.path, offset);
  }

  _apply(record) {
    this.records.push(record);
    if (record.type === 'loadPack') {
      let pack = this.packs.get(record.name);
      if (!pack) {
        pack = { versions: new Map(), current: null };
        this.packs.set(record.name, pack);
      }
      pack.versions.set(record.version, {
        alphabet: record.alphabet,
        danger: record.danger,
      });
      pack.current = record.version;
    } else if (record.type === 'rollback') {
      const pack = this.packs.get(record.name);
      if (pack && pack.versions.has(record.version)) {
        pack.current = record.version;
      }
    }
  }

  _append(record) {
    const line = JSON.stringify({ crc: crc32(JSON.stringify(record)), data: record });
    fs.appendFileSync(this.path, line + '\n');
    this._apply(record);
  }

  loadPack({ name, version, alphabet, danger }) {
    if (!name || typeof version !== 'number' || !danger) {
      throw new Error('loadPack requires name, version (number) and danger');
    }
    this._append({ type: 'loadPack', name, version, alphabet: alphabet || null, danger });
  }

  rollback({ name, version }) {
    const pack = this.packs.get(name);
    if (!pack) {
      const err = new Error(`unknown pack '${name}'`);
      err.code = 'UNKNOWN_PACK';
      throw err;
    }
    if (!pack.versions.has(version)) {
      const err = new Error(`unknown version ${version} of pack '${name}'`);
      err.code = 'UNKNOWN_VERSION';
      throw err;
    }
    this._append({ type: 'rollback', name, version });
  }

  currentPack(name) {
    const pack = this.packs.get(name);
    if (!pack || pack.current === null) return null;
    return { name, version: pack.current, ...pack.versions.get(pack.current) };
  }
}

module.exports = { PackStore, crc32, CrcError };
