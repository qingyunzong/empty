import { crc32 } from './crc32.js';
import { AlertError } from './errors.js';

// Segment file layout:
//   header (24 bytes): magic(8) "ALSEG001", u32 segmentId, u32 chunkSize,
//                      u32 chunkCount, u32 recordCount
//   data region: chunkCount * chunkSize bytes, records packed as
//                [u32 length][JSON payload]; a record never crosses a chunk
//                boundary; remaining bytes in a chunk are zero padding
//   trailer (4 bytes): u32 CRC32 over header + data region
export const MAGIC = Buffer.from('ALSEG001', 'ascii');
export const HEADER_SIZE = 24;
export const TRAILER_SIZE = 4;

export function encodeSegment({ segmentId, chunkSize, chunkCount, records }) {
  const payloads = records.map((r) => Buffer.from(JSON.stringify(r), 'utf8'));
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(segmentId, 8);
  header.writeUInt32LE(chunkSize, 12);
  header.writeUInt32LE(chunkCount, 16);
  header.writeUInt32LE(records.length, 20);

  const data = Buffer.alloc(chunkSize * chunkCount);
  const offsets = [];
  let chunkIndex = 0;
  let pos = 0;
  for (const payload of payloads) {
    if (payload.length + 4 > chunkSize) {
      throw new AlertError(
        'E_RECORD_TOO_LARGE',
        `record of ${payload.length} bytes does not fit in chunk of ${chunkSize} bytes`,
      );
    }
    if (pos + 4 + payload.length > chunkSize) {
      chunkIndex += 1;
      pos = 0;
    }
    if (chunkIndex >= chunkCount) {
      throw new AlertError('E_SEGMENT_FULL', `segment ${segmentId} is full`);
    }
    const off = chunkIndex * chunkSize + pos;
    data.writeUInt32LE(payload.length, off);
    payload.copy(data, off + 4);
    offsets.push(HEADER_SIZE + off);
    pos += 4 + payload.length;
  }

  const body = Buffer.concat([header, data]);
  const trailer = Buffer.alloc(TRAILER_SIZE);
  trailer.writeUInt32LE(crc32(body), 0);
  return { fileBuffer: Buffer.concat([body, trailer]), offsets };
}

export function decodeSegment(buf) {
  if (buf.length < HEADER_SIZE + TRAILER_SIZE) {
    throw new AlertError('E_MALFORMED', 'segment file too small');
  }
  if (!buf.subarray(0, 8).equals(MAGIC)) {
    throw new AlertError('E_MALFORMED', 'bad segment magic');
  }
  const storedCrc = buf.readUInt32LE(buf.length - TRAILER_SIZE);
  const actualCrc = crc32(buf.subarray(0, buf.length - TRAILER_SIZE));
  if (storedCrc !== actualCrc) {
    throw new AlertError(
      'E_CRC',
      `segment CRC mismatch: stored=${storedCrc.toString(16)} actual=${actualCrc.toString(16)}`,
    );
  }
  const segmentId = buf.readUInt32LE(8);
  const chunkSize = buf.readUInt32LE(12);
  const chunkCount = buf.readUInt32LE(16);
  const recordCount = buf.readUInt32LE(20);
  if (buf.length !== HEADER_SIZE + chunkSize * chunkCount + TRAILER_SIZE) {
    throw new AlertError('E_MALFORMED', 'segment file size does not match header');
  }

  const records = [];
  for (let c = 0; c < chunkCount; c++) {
    const chunkStart = HEADER_SIZE + c * chunkSize;
    const chunkEnd = chunkStart + chunkSize;
    let pos = chunkStart;
    while (pos + 4 <= chunkEnd) {
      const len = buf.readUInt32LE(pos);
      if (len === 0) break; // zero padding to end of chunk
      if (pos + 4 + len > chunkEnd) {
        throw new AlertError('E_MALFORMED', 'record overruns chunk boundary');
      }
      const record = JSON.parse(buf.subarray(pos + 4, pos + 4 + len).toString('utf8'));
      records.push({ offset: pos, record }); // offset = absolute file offset of record header
      pos += 4 + len;
    }
  }
  if (records.length !== recordCount) {
    throw new AlertError('E_MALFORMED', 'record count does not match header');
  }
  return { segmentId, chunkSize, chunkCount, records };
}
