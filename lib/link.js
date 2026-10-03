'use strict';

const PMAGIC = 0x4c4b; // 'LK'
const HEADER = 8;

class LinkError extends Error {
  constructor(message) {
    super(message);
    this.code = 'LINK';
    this.exitCode = 2;
  }
}

// Link packet layout (big-endian):
//   0  u16  magic 'LK'
//   2  u16  frameId
//   4  u8   fragIdx
//   5  u8   fragTotal
//   6  u16  payloadLen
//   8  ...  payload (a slice of a frame)
function encodePacket({ frameId, fragIdx, fragTotal, payload }) {
  const b = Buffer.alloc(HEADER + payload.length);
  b.writeUInt16BE(PMAGIC, 0);
  b.writeUInt16BE(frameId, 2);
  b.writeUInt8(fragIdx, 4);
  b.writeUInt8(fragTotal, 5);
  b.writeUInt16BE(payload.length, 6);
  payload.copy(b, HEADER);
  return b;
}

function fragmentFrame(frameBuf, frameId, fragSize = 16) {
  const total = Math.max(1, Math.ceil(frameBuf.length / fragSize));
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push(encodePacket({
      frameId,
      fragIdx: i,
      fragTotal: total,
      payload: frameBuf.subarray(i * fragSize, (i + 1) * fragSize),
    }));
  }
  return out;
}

// Reassembles frames from a stream of packets that may be duplicated
// (retransmission), out of order, interleaved and fragmented.
class Reassembler {
  constructor() {
    this.pending = new Map(); // frameId -> { total, frags: Map(idx -> Buffer) }
    this.done = new Set(); // frameIds already completed
    this.warnings = [];
  }

  // Returns completed frames, in completion order.
  feed(stream) {
    const done = [];
    let off = 0;
    while (off < stream.length) {
      if (off + HEADER > stream.length) {
        throw new LinkError(`truncated packet header at offset ${off}`);
      }
      if (stream.readUInt16BE(off) !== PMAGIC) {
        throw new LinkError(`bad packet magic at offset ${off}`);
      }
      const frameId = stream.readUInt16BE(off + 2);
      const idx = stream.readUInt8(off + 4);
      const total = stream.readUInt8(off + 5);
      const len = stream.readUInt16BE(off + 6);
      if (total === 0 || idx >= total) {
        throw new LinkError(`bad fragment header frame=${frameId} idx=${idx} total=${total}`);
      }
      if (off + HEADER + len > stream.length) {
        throw new LinkError(`truncated packet payload at offset ${off}`);
      }
      const payload = stream.subarray(off + HEADER, off + HEADER + len);
      off += HEADER + len;

      if (this.done.has(frameId)) {
        this.warnings.push(`late fragment frame=${frameId} idx=${idx} ignored (frame already complete)`);
        continue;
      }
      let rec = this.pending.get(frameId);
      if (rec && rec.total !== total) {
        throw new LinkError(`fragment total mismatch for frame=${frameId}`);
      }
      if (!rec) {
        rec = { total, frags: new Map() };
        this.pending.set(frameId, rec);
      }
      if (rec.frags.has(idx)) {
        this.warnings.push(`duplicate fragment frame=${frameId} idx=${idx} ignored (retransmission)`);
        continue;
      }
      rec.frags.set(idx, Buffer.from(payload));
      if (rec.frags.size === rec.total) {
        const parts = [];
        for (let i = 0; i < rec.total; i++) parts.push(rec.frags.get(i));
        this.pending.delete(frameId);
        this.done.add(frameId);
        done.push(Buffer.concat(parts));
      }
    }
    return done;
  }
}

module.exports = { LinkError, encodePacket, fragmentFrame, Reassembler };
