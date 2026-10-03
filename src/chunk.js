import { QrecError } from './errors.js';
import { crc32 } from './crc32.js';
import { ByteWriter, uvarintDecode, zigzagDecode } from './encoding.js';

export const MAGIC = 0x51524331; // 'QRC1'

export const RecordType = Object.freeze({
  BASELINE: 0,
  MEASURE: 1,
  COMPENSATE: 2,
});

// Chunk layout (all big-endian):
//   magic u32 | chunkSeq u32 | batchIdLen u8 | batchId utf8
//   baseTime u64 | baseValueScaled i64 | recordCount u32
//   records... | crc32 u32 (over everything before it)
//
// Each record stores time as zigzag delta from baseTime and value as zigzag
// delta from the previous record value (chain starts at baseValueScaled), so
// every chunk is self-contained and late/out-of-order timestamps are legal.
export function encodeChunk({ chunkSeq, batchId, baseTime, baseValueScaled, records }) {
  const id = Buffer.from(batchId, 'utf8');
  if (id.length > 255) throw new QrecError('E_VALUE', 'batchId too long');
  const w = new ByteWriter();
  w.u32be(MAGIC);
  w.u32be(chunkSeq);
  w.u8(id.length);
  w.bytes(id);
  w.u64be(baseTime);
  w.i64be(baseValueScaled);
  w.u32be(records.length);
  let prev = baseValueScaled;
  for (const r of records) {
    w.u8(r.type);
    switch (r.type) {
      case RecordType.BASELINE:
        w.zvarint(r.time - baseTime);
        w.zvarint(r.valueScaled - prev);
        break;
      case RecordType.MEASURE:
        w.varint(r.seq);
        w.zvarint(r.time - baseTime);
        w.zvarint(r.valueScaled - prev);
        break;
      case RecordType.COMPENSATE: {
        w.varint(r.targetSeq);
        w.zvarint(r.time - baseTime);
        w.zvarint(r.valueScaled - prev);
        const reason = Buffer.from(r.reason ?? '', 'utf8');
        w.varint(reason.length);
        w.bytes(reason);
        break;
      }
      default:
        throw new QrecError('E_VALUE', `unknown record type ${r.type}`);
    }
    prev = r.valueScaled;
  }
  const body = w.concat();
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([body, tail]);
}

export function decodeChunk(buf) {
  if (buf.length < 8) throw new QrecError('E_CRC', 'chunk too small');
  const stored = buf.readUInt32BE(buf.length - 4);
  const computed = crc32(buf.subarray(0, buf.length - 4));
  if (stored !== computed) {
    throw new QrecError(
      'E_CRC',
      `chunk CRC mismatch: stored 0x${stored.toString(16)}, computed 0x${computed.toString(16)}`
    );
  }
  let offset = 0;
  const magic = buf.readUInt32BE(offset);
  offset += 4;
  if (magic !== MAGIC) throw new QrecError('E_FORMAT', 'bad chunk magic');
  const chunkSeq = buf.readUInt32BE(offset);
  offset += 4;
  const idLen = buf.readUInt8(offset);
  offset += 1;
  const batchId = buf.subarray(offset, offset + idLen).toString('utf8');
  offset += idLen;
  const baseTime = Number(buf.readBigUInt64BE(offset));
  offset += 8;
  const baseValueScaled = Number(buf.readBigInt64BE(offset));
  offset += 8;
  const recordCount = buf.readUInt32BE(offset);
  offset += 4;
  const records = [];
  let prev = baseValueScaled;
  for (let i = 0; i < recordCount; i++) {
    const type = buf.readUInt8(offset);
    offset += 1;
    if (type === RecordType.BASELINE) {
      const t = uvarintDecode(buf, offset);
      offset = t.offset;
      const v = uvarintDecode(buf, offset);
      offset = v.offset;
      const valueScaled = prev + zigzagDecode(v.value);
      records.push({ type, time: baseTime + zigzagDecode(t.value), valueScaled });
      prev = valueScaled;
    } else if (type === RecordType.MEASURE) {
      const s = uvarintDecode(buf, offset);
      offset = s.offset;
      const t = uvarintDecode(buf, offset);
      offset = t.offset;
      const v = uvarintDecode(buf, offset);
      offset = v.offset;
      const valueScaled = prev + zigzagDecode(v.value);
      records.push({ type, seq: s.value, time: baseTime + zigzagDecode(t.value), valueScaled });
      prev = valueScaled;
    } else if (type === RecordType.COMPENSATE) {
      const s = uvarintDecode(buf, offset);
      offset = s.offset;
      const t = uvarintDecode(buf, offset);
      offset = t.offset;
      const v = uvarintDecode(buf, offset);
      offset = v.offset;
      const rl = uvarintDecode(buf, offset);
      offset = rl.offset;
      const reason = buf.subarray(offset, offset + rl.value).toString('utf8');
      offset += rl.value;
      const valueScaled = prev + zigzagDecode(v.value);
      records.push({
        type,
        targetSeq: s.value,
        time: baseTime + zigzagDecode(t.value),
        valueScaled,
        reason,
      });
      prev = valueScaled;
    } else {
      throw new QrecError('E_FORMAT', `unknown record type ${type}`);
    }
  }
  return { chunkSeq, batchId, baseTime, baseValueScaled, records };
}
