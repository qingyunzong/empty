'use strict';

const fs = require('node:fs');
const {
  MAGIC,
  BLOCK_DICT,
  BLOCK_RECORDS,
  BLOCK_INDEX,
  BLOCK_HEADER_LEN,
  FOOTER_LEN,
  FormatError,
  decodeDictBlockPayload,
  decodeRecordBlockPayload,
  parseBlockHeader,
  decodeIndex,
  parseFooter,
} = require('./format');
const { crc32 } = require('./crc32');

function indexDictEntries(entries) {
  const byField = { gtin: new Map(), batch: new Map(), station: new Map() };
  for (const e of entries) byField[e.field].set(e.id, e.value);
  return byField;
}

// Shared record resolution: turns dict-id records into plain tags, routing
// failures to emitErr with the proper code.
function resolveRecords(dicts, decoded, blockOffset, emit, emitErr) {
  const dv = dicts.get(decoded.dictVersion);
  decoded.records.forEach((rec, i) => {
    if (!dv) {
      emitErr({
        code: 'E_DICTREF',
        blockOffset,
        recordIndex: i,
        dictVersion: decoded.dictVersion,
        message: `unknown dictionary version ${decoded.dictVersion}`,
      });
      return;
    }
    if (dv.status !== 'ok') {
      emitErr({
        code: 'E_DICT',
        blockOffset,
        recordIndex: i,
        dictVersion: decoded.dictVersion,
        message: `dictionary version ${decoded.dictVersion} is corrupt`,
      });
      return;
    }
    const gtin = dv.byField.gtin.get(rec.gtinId);
    const batch = dv.byField.batch.get(rec.batchId);
    const station = dv.byField.station.get(rec.stationId);
    if (gtin === undefined || batch === undefined || station === undefined) {
      emitErr({
        code: 'E_DICTREF',
        blockOffset,
        recordIndex: i,
        dictVersion: decoded.dictVersion,
        message: 'record references unknown dictionary id',
      });
      return;
    }
    emit({ gtin, batch, station, serial: rec.serial, time: rec.timeMs });
  });
}

function readFileIndex(buf) {
  if (buf.length < MAGIC.length + FOOTER_LEN) {
    throw new FormatError('file too short');
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new FormatError('bad magic');
  const footer = parseFooter(buf);
  const hdr = parseBlockHeader(buf, footer.indexOffset);
  if (!hdr || hdr.type !== BLOCK_INDEX) throw new FormatError('bad index block');
  const indexPayload = buf.subarray(
    footer.indexOffset + BLOCK_HEADER_LEN,
    footer.indexOffset + hdr.totalLen
  );
  if (
    indexPayload.length !== hdr.payloadLen ||
    crc32(indexPayload) !== hdr.crc ||
    crc32(indexPayload) !== footer.indexCrc
  ) {
    throw new FormatError('index crc mismatch');
  }
  return decodeIndex(indexPayload);
}

function readPack(path) {
  const buf = fs.readFileSync(path);
  const entries = readFileIndex(buf);
  const dicts = new Map();
  const errors = [];

  for (const e of entries) {
    if (e.type !== BLOCK_DICT) continue;
    const payload = buf.subarray(
      e.offset + BLOCK_HEADER_LEN,
      e.offset + e.totalLen
    );
    const hdr = parseBlockHeader(buf, e.offset);
    if (!hdr || hdr.crc !== crc32(payload)) {
      dicts.set(e.version, { status: 'corrupt' });
      errors.push({ code: 'E_DICT', dictVersion: e.version, blockOffset: e.offset });
      continue;
    }
    try {
      const d = decodeDictBlockPayload(payload);
      dicts.set(d.version, { status: 'ok', byField: indexDictEntries(d.entries) });
    } catch {
      dicts.set(e.version, { status: 'corrupt' });
      errors.push({ code: 'E_DICT', dictVersion: e.version, blockOffset: e.offset });
    }
  }

  const records = [];
  for (const e of entries) {
    if (e.type !== BLOCK_RECORDS) continue;
    const payload = buf.subarray(
      e.offset + BLOCK_HEADER_LEN,
      e.offset + e.totalLen
    );
    const hdr = parseBlockHeader(buf, e.offset);
    if (!hdr || hdr.crc !== crc32(payload)) {
      errors.push({ code: 'E_CRC', blockOffset: e.offset });
      continue;
    }
    let decoded;
    try {
      decoded = decodeRecordBlockPayload(payload);
    } catch {
      errors.push({ code: 'E_CRC', blockOffset: e.offset });
      continue;
    }
    resolveRecords(
      dicts,
      decoded,
      e.offset,
      (rec) => records.push(rec),
      (err) => errors.push(err)
    );
  }

  return {
    records,
    errors,
    dictVersions: [...dicts.keys()].sort((a, b) => a - b),
  };
}

module.exports = { readPack, readFileIndex, resolveRecords, indexDictEntries };
