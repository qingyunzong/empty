import { crc32 } from './crc32.js';
import { Graph } from './graph.js';
import { RouteError } from './errors.js';

export const BLOCK_META = 1;
export const BLOCK_INDEX = 2;
export const BLOCK_NODES = 3;

const HEADER_SIZE = 8;
const CRC_SIZE = 4;

export function encodeBlock(type, payload) {
  const block = Buffer.alloc(HEADER_SIZE + payload.length + CRC_SIZE);
  block.writeUInt32LE(type, 0);
  block.writeUInt32LE(payload.length, 4);
  payload.copy(block, HEADER_SIZE);
  block.writeUInt32LE(crc32(block.subarray(0, HEADER_SIZE + payload.length)), HEADER_SIZE + payload.length);
  return block;
}

export function readBlockAt(buffer, offset) {
  if (offset + HEADER_SIZE > buffer.length) {
    throw new RouteError('E_CORRUPT', `truncated block header at ${offset}`);
  }
  const type = buffer.readUInt32LE(offset);
  const length = buffer.readUInt32LE(offset + 4);
  if (offset + HEADER_SIZE + length + CRC_SIZE > buffer.length) {
    throw new RouteError('E_CORRUPT', `truncated block at ${offset}`);
  }
  const body = buffer.subarray(offset, offset + HEADER_SIZE + length);
  const expected = buffer.readUInt32LE(offset + HEADER_SIZE + length);
  if (crc32(body) !== expected) {
    throw new RouteError('E_CORRUPT', `crc mismatch at block offset ${offset}`);
  }
  return { type, payload: buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length) };
}

function encodeRecord(node, edges) {
  const json = Buffer.from(JSON.stringify({ node, edges }), 'utf8');
  const rec = Buffer.alloc(4 + json.length);
  rec.writeUInt32LE(json.length, 0);
  json.copy(rec, 4);
  return rec;
}

export function encodeGraph(graph, { chunkSize = 8 } = {}) {
  const nodeIds = graph.nodeIds();
  const records = nodeIds.map((id) => ({ id, rec: encodeRecord(graph.nodes.get(id), graph.neighbors(id)) }));

  const nodeBlocks = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    const group = records.slice(i, i + chunkSize);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(group.length, 0);
    nodeBlocks.push({ records: group, payload: Buffer.concat([count, ...group.map((g) => g.rec)]) });
  }

  const metaPayload = Buffer.from(
    JSON.stringify({
      format: 'PRL1',
      chunkSize,
      devices: [...graph.devices.values()]
        .map((d) => ({ id: d.id, capacity: d.capacity }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      nodeCount: nodeIds.length,
      edgeCount: [...graph.adj.values()].reduce((s, e) => s + e.length, 0),
    }),
    'utf8',
  );
  const metaBlock = encodeBlock(BLOCK_META, metaPayload);

  let indexBlock = Buffer.alloc(0);
  for (let iter = 0; iter < 20; iter++) {
    let offset = metaBlock.length + indexBlock.length;
    const entries = [];
    nodeBlocks.forEach((nb, bi) => {
      const blockOffset = offset;
      let recOffset = offset + HEADER_SIZE + 4;
      for (const r of nb.records) {
        entries.push({ id: r.id, block: bi + 2, blockOffset, offset: recOffset });
        recOffset += r.rec.length;
      }
      offset += HEADER_SIZE + nb.payload.length + CRC_SIZE;
    });
    const next = encodeBlock(BLOCK_INDEX, Buffer.from(JSON.stringify({ entries }), 'utf8'));
    if (next.equals(indexBlock)) break;
    indexBlock = next;
    if (iter === 19) throw new Error('index offset fixpoint did not converge');
  }

  return Buffer.concat([metaBlock, indexBlock, ...nodeBlocks.map((nb) => encodeBlock(BLOCK_NODES, nb.payload))]);
}

function applyMeta(graph, payload) {
  const meta = JSON.parse(payload.toString('utf8'));
  for (const d of meta.devices ?? []) graph.addDevice(d.id, d.capacity);
  return meta;
}

function applyNodesBlock(graph, payload) {
  const count = payload.readUInt32LE(0);
  let pos = 4;
  const applied = [];
  for (let i = 0; i < count; i++) {
    const len = payload.readUInt32LE(pos);
    const rec = JSON.parse(payload.subarray(pos + 4, pos + 4 + len).toString('utf8'));
    graph.addNode(rec.node);
    for (const to of rec.edges ?? []) graph.addEdge(rec.node.id, to);
    applied.push(rec.node.id);
    pos += 4 + len;
  }
  return applied;
}

export function decodeIncremental(buffer) {
  const graph = new Graph();
  const result = {
    graph,
    meta: null,
    index: null,
    blocks: [],
    nodeOrder: [],
    corruptedAt: null,
    truncated: false,
    complete: false,
  };
  let pos = 0;
  let blockIndex = 0;
  while (pos < buffer.length) {
    if (pos + HEADER_SIZE > buffer.length) {
      result.truncated = true;
      break;
    }
    const type = buffer.readUInt32LE(pos);
    const length = buffer.readUInt32LE(pos + 4);
    if (pos + HEADER_SIZE + length + CRC_SIZE > buffer.length) {
      result.truncated = true;
      break;
    }
    const body = buffer.subarray(pos, pos + HEADER_SIZE + length);
    const expected = buffer.readUInt32LE(pos + HEADER_SIZE + length);
    if (crc32(body) !== expected) {
      result.corruptedAt = blockIndex;
      break;
    }
    const payload = buffer.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + length);
    result.blocks.push({ index: blockIndex, type, offset: pos, length });
    if (type === BLOCK_META) {
      result.meta = applyMeta(graph, payload);
    } else if (type === BLOCK_INDEX) {
      result.index = JSON.parse(payload.toString('utf8'));
    } else if (type === BLOCK_NODES) {
      result.nodeOrder.push(...applyNodesBlock(graph, payload));
    }
    pos += HEADER_SIZE + length + CRC_SIZE;
    blockIndex++;
  }
  result.complete = result.corruptedAt === null && !result.truncated && pos === buffer.length;
  return result;
}

export function decode(buffer) {
  const result = decodeIncremental(buffer);
  if (!result.complete) {
    throw new RouteError('E_CORRUPT', `corrupted at block ${result.corruptedAt ?? 'eof'}`);
  }
  return result;
}

export function getNode(buffer, nodeId) {
  const metaBlock = readBlockAt(buffer, 0);
  if (metaBlock.type !== BLOCK_META) throw new RouteError('E_CORRUPT', 'missing meta block');
  const indexBlock = readBlockAt(buffer, metaBlock.payload.length + HEADER_SIZE + CRC_SIZE);
  if (indexBlock.type !== BLOCK_INDEX) throw new RouteError('E_CORRUPT', 'missing index block');
  const index = JSON.parse(indexBlock.payload.toString('utf8'));
  const entry = index.entries.find((e) => e.id === nodeId);
  if (!entry) return null;
  readBlockAt(buffer, entry.blockOffset);
  const len = buffer.readUInt32LE(entry.offset);
  return JSON.parse(buffer.subarray(entry.offset + 4, entry.offset + 4 + len).toString('utf8'));
}
