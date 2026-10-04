'use strict';

const {
  MAGIC,
  BLOCK_DICT,
  BLOCK_RECORDS,
  BLOCK_INDEX,
  BLOCK_HEADER_LEN,
  decodeDictBlockPayload,
  decodeRecordBlockPayload,
  parseBlockHeader,
} = require('./format');
const { crc32 } = require('./crc32');
const { resolveRecords, indexDictEntries } = require('./reader');

// Incremental block-at-a-time decoder. Bytes may be fed in arbitrarily sized
// chunks; a multi-byte UTF-8 sequence may be split across chunk boundaries
// without producing mojibake or dropped characters, because strings are only
// decoded once a complete block payload has been accumulated.
class Decoder {
  constructor({ onRecord, onError, onDict } = {}) {
    this._onRecord = onRecord || (() => {});
    this._onError = onError || (() => {});
    this._onDict = onDict || (() => {});
    this._buf = Buffer.alloc(0);
    this._consumed = 0; // absolute offset of this._buf[0] in the stream
    this._magicOk = false;
    this._broken = false;
    this._hdr = null; // parsed header of the block currently being assembled
    this._hdrOffset = 0;
    this.dicts = new Map();
  }

  feed(chunk) {
    if (this._broken || this._done) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._buf = this._buf.length ? Buffer.concat([this._buf, buf]) : buf;
    this._pump();
  }

  end() {
    if (this._broken || this._done) return;
    if (this._buf.length > 0 || !this._magicOk) {
      this._error({ code: 'E_FORMAT', message: 'truncated stream' });
    }
  }

  _error(err) {
    this._onError(err);
  }

  _advance(n) {
    this._buf = this._buf.subarray(n);
    this._consumed += n;
  }

  _pump() {
    for (;;) {
      if (!this._magicOk) {
        if (this._buf.length < MAGIC.length) return;
        if (!this._buf.subarray(0, MAGIC.length).equals(MAGIC)) {
          this._error({ code: 'E_FORMAT', message: 'bad magic' });
          this._broken = true;
          return;
        }
        this._advance(MAGIC.length);
        this._magicOk = true;
        continue;
      }
      if (!this._hdr) {
        const hdr = parseBlockHeader(this._buf, 0);
        if (!hdr) return;
        this._hdr = hdr;
        this._hdrOffset = this._consumed;
        this._advance(BLOCK_HEADER_LEN);
        continue;
      }
      if (this._buf.length < this._hdr.payloadLen) return;
      const payload = this._buf.subarray(0, this._hdr.payloadLen);
      this._advance(this._hdr.payloadLen);
      const hdr = this._hdr;
      const offset = this._hdrOffset;
      this._hdr = null;
      this._processBlock(hdr, payload, offset);
      if (this._broken) return;
      if (this._done) {
        // Index block marks the end of the data section; only the
        // fixed-size footer may follow.
        this._advance(this._buf.length);
        return;
      }
    }
  }

  _processBlock(hdr, payload, offset) {
    if (hdr.type === BLOCK_DICT) {
      const version = payload.length >= 4 ? payload.readUInt32LE(0) : null;
      if (crc32(payload) !== hdr.crc) {
        this.dicts.set(version, { status: 'corrupt' });
        this._error({ code: 'E_DICT', dictVersion: version, blockOffset: offset });
        return;
      }
      try {
        const d = decodeDictBlockPayload(payload);
        this.dicts.set(d.version, {
          status: 'ok',
          byField: indexDictEntries(d.entries),
        });
        this._onDict(d.version);
      } catch {
        this.dicts.set(version, { status: 'corrupt' });
        this._error({ code: 'E_DICT', dictVersion: version, blockOffset: offset });
      }
      return;
    }
    if (hdr.type === BLOCK_INDEX) {
      if (crc32(payload) !== hdr.crc) {
        this._error({ code: 'E_FORMAT', message: 'index crc mismatch', blockOffset: offset });
        return;
      }
      this._done = true;
      return;
    }
    if (hdr.type === BLOCK_RECORDS) {
      if (crc32(payload) !== hdr.crc) {
        this._error({ code: 'E_CRC', blockOffset: offset });
        return;
      }
      let decoded;
      try {
        decoded = decodeRecordBlockPayload(payload);
      } catch {
        this._error({ code: 'E_CRC', blockOffset: offset });
        return;
      }
      resolveRecords(
        this.dicts,
        decoded,
        offset,
        (rec) => this._onRecord(rec),
        (err) => this._error(err)
      );
      return;
    }
    this._error({ code: 'E_FORMAT', message: `unknown block type ${hdr.type}`, blockOffset: offset });
  }
}

module.exports = { Decoder };
