'use strict';

const fs = require('node:fs');

// ---------- CRC-32 (IEEE) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function crc32hex(str) {
  return crc32(Buffer.from(str, 'utf8')).toString(16).padStart(8, '0');
}

// ---------- errors (all map to CLI exit code 5) ----------

class PackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.exitCode = 5;
  }
}

// ---------- append-only record layer ----------
// Each line: {"crc":"<crc32 of body json>","body":{...}} terminated by '\n'.

function encodeRecord(body) {
  const payload = JSON.stringify(body);
  return `${JSON.stringify({ crc: crc32hex(payload), body })}\n`;
}

function appendRecord(path, body) {
  repairTail(path);
  fs.appendFileSync(path, encodeRecord(body));
  return body;
}

// Verify records one by one; a torn final record (no trailing newline, or
// unparseable) is truncated so the file ends after the last good record.
// A CRC mismatch on a complete, newline-terminated record is real corruption.
function loadRecords(path) {
  if (!fs.existsSync(path)) {
    throw new PackError('UNKNOWN_PACK', `pack file not found: ${path}`);
  }
  const buf = fs.readFileSync(path);
  const records = [];
  let offset = 0;
  let goodEnd = 0;
  let truncated = false;

  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    const complete = nl !== -1;
    const end = complete ? nl : buf.length;
    const line = buf.subarray(offset, end).toString('utf8');
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {
      obj = null;
    }
    const valid = obj !== null
      && typeof obj === 'object'
      && typeof obj.crc === 'string'
      && obj.body !== undefined
      && obj.crc === crc32hex(JSON.stringify(obj.body));

    if (!valid) {
      if (!complete) {
        // Torn tail from an interrupted append: drop it and stop.
        truncated = true;
        break;
      }
      const crcOk = obj !== null && typeof obj === 'object' && typeof obj.crc === 'string'
        && obj.body !== undefined;
      if (crcOk) {
        throw new PackError('CRC_FAILED', `CRC check failed at byte offset ${offset} in ${path}`);
      }
      throw new PackError('CRC_FAILED', `corrupt record at byte offset ${offset} in ${path}`);
    }
    records.push(obj.body);
    goodEnd = end + 1;
    offset = end + 1;
  }

  if (truncated) {
    fs.truncateSync(path, goodEnd);
  }
  return { records, truncated };
}

function repairTail(path) {
  if (!fs.existsSync(path)) return;
  loadRecords(path); // truncates a torn tail as a side effect
}

// ---------- rule pack domain layer ----------
// Record body: {type:"pack", version:n, rules:[{id,pattern,filter?,alphabet?}]}

function appendPack(path, rules) {
  const { records } = fs.existsSync(path)
    ? loadRecords(path)
    : { records: [] };
  const version = records.length + 1;
  appendRecord(path, { type: 'pack', version, rules });
  return version;
}

function loadPack(path) {
  const { records, truncated } = loadRecords(path);
  const versions = [];
  for (const rec of records) {
    if (rec.type !== 'pack' || !Array.isArray(rec.rules)) {
      throw new PackError('CRC_FAILED', `malformed pack record in ${path}`);
    }
    versions.push(rec);
  }
  if (versions.length === 0) {
    throw new PackError('UNKNOWN_PACK', `pack file has no versions: ${path}`);
  }
  return { versions, current: versions.length, truncated };
}

module.exports = { crc32hex, encodeRecord, appendRecord, loadRecords, appendPack, loadPack, PackError };
