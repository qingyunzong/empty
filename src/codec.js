import { crc32 } from './crc32.js';
import { emptyGraph, addNode, addEdge } from './graph.js';

export const MAGIC = Buffer.from('RTG1', 'ascii');
export const RECORDS_PER_CHUNK = 4;

// File layout:
//   magic(4) | headerLen(uint32 LE) | header JSON | chunks...
// Header JSON: { ...meta, chunkCount, index: { nodeId: [chunkIdx, byteOffsetInChunk] } }
// Chunk: payloadLen(uint32 LE) | crc32(uint32 LE) | payload (JSON lines)
// Record line: {"n":{id,op,device,time}} or {"e":[from,to]}

export function encodeGraph(graph, meta = {}) {
  const records = [];
  for (const id of [...graph.nodes.keys()].sort()) {
    records.push({ n: graph.nodes.get(id) });
    for (const to of [...(graph.edges.get(id) ?? [])].sort()) {
      records.push({ e: [id, to] });
    }
  }

  const index = {};
  const chunkBufs = [];
  for (let i = 0; i < records.length; i += RECORDS_PER_CHUNK) {
    const chunkIdx = chunkBufs.length;
    let payload = '';
    for (const rec of records.slice(i, i + RECORDS_PER_CHUNK)) {
      const line = JSON.stringify(rec) + '\n';
      if (rec.n) index[rec.n.id] = [chunkIdx, Buffer.byteLength(payload, 'utf8')];
      payload += line;
    }
    const pbuf = Buffer.from(payload, 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(pbuf.length, 0);
    head.writeUInt32LE(crc32(pbuf), 4);
    chunkBufs.push(Buffer.concat([head, pbuf]));
  }

  const header = Buffer.from(
    JSON.stringify({ ...meta, chunkCount: chunkBufs.length, index }),
    'utf8',
  );
  const hlen = Buffer.alloc(4);
  hlen.writeUInt32LE(header.length, 0);
  return Buffer.concat([MAGIC, hlen, header, ...chunkBufs]);
}

class CorruptError extends Error {
  constructor(message, chunk) {
    super(message);
    this.chunk = chunk;
  }
}

// Incremental decoder: applies one chunk at a time. On CRC mismatch or
// truncation it stops and returns the graph built from the valid prefix.
export function decodeIncremental(buffer) {
  const graph = emptyGraph();
  const result = {
    graph,
    meta: null,
    chunkCount: 0,
    chunksRead: 0,
    error: null,
  };
  try {
    if (buffer.length < 8 || !buffer.subarray(0, 4).equals(MAGIC)) {
      throw new CorruptError('bad magic or truncated header', 0);
    }
    const hlen = buffer.readUInt32LE(4);
    if (buffer.length < 8 + hlen) throw new CorruptError('truncated header', 0);
    const header = JSON.parse(buffer.subarray(8, 8 + hlen).toString('utf8'));
    result.meta = header;
    result.chunkCount = header.chunkCount ?? 0;

    let pos = 8 + hlen;
    for (let ci = 0; ci < result.chunkCount; ci++) {
      if (pos + 8 > buffer.length) throw new CorruptError('truncated chunk header', ci);
      const len = buffer.readUInt32LE(pos);
      const crc = buffer.readUInt32LE(pos + 4);
      if (pos + 8 + len > buffer.length) throw new CorruptError('truncated chunk payload', ci);
      const payload = buffer.subarray(pos + 8, pos + 8 + len);
      if (crc32(payload) !== crc) {
        throw new CorruptError(`crc32 mismatch in chunk ${ci}`, ci);
      }
      for (const line of payload.toString('utf8').split('\n')) {
        if (!line) continue;
        const rec = JSON.parse(line);
        if (rec.n) addNode(graph, rec.n);
        else if (rec.e) addEdge(graph, rec.e[0], rec.e[1]);
      }
      result.chunksRead++;
      pos += 8 + len;
    }
  } catch (err) {
    result.error = {
      code: 'E_CORRUPT',
      message: err.message,
      chunk: err.chunk ?? result.chunksRead,
    };
  }
  return result;
}
