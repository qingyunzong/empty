import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../src/crc32.js';
import { encodeGraph, decodeIncremental } from '../src/codec.js';
import { emptyGraph, addNode, addEdge } from '../src/graph.js';

function sampleGraph(n = 10) {
  const g = emptyGraph();
  for (let i = 0; i < n; i++) {
    addNode(g, { id: `n${i}`, op: i, device: i % 2 ? 'A' : 'B', time: i + 1 });
    if (i > 0) addEdge(g, `n${i - 1}`, `n${i}`);
  }
  return g;
}

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('encode/decode roundtrip preserves the graph', () => {
  const g = sampleGraph();
  const buf = encodeGraph(g, { version: 'v1' });
  const res = decodeIncremental(buf);
  assert.equal(res.error, null);
  assert.equal(res.meta.version, 'v1');
  assert.equal(res.chunksRead, res.chunkCount);
  assert.deepEqual([...res.graph.nodes.keys()], [...g.nodes.keys()]);
  for (const [id, node] of g.nodes) {
    assert.deepEqual(res.graph.nodes.get(id), node);
  }
  for (const [from, outs] of g.edges) {
    assert.deepEqual([...res.graph.edges.get(from)], [...outs]);
  }
});

test('index offsets locate each node record inside its chunk', () => {
  const g = sampleGraph();
  const buf = encodeGraph(g, {});
  const res = decodeIncremental(buf);
  const index = res.meta.index;
  assert.deepEqual(Object.keys(index).sort(), [...g.nodes.keys()].sort());

  const hlen = buf.readUInt32LE(4);
  let pos = 8 + hlen;
  const payloads = [];
  for (let ci = 0; ci < res.chunkCount; ci++) {
    const len = buf.readUInt32LE(pos);
    payloads.push(buf.subarray(pos + 8, pos + 8 + len).toString('utf8'));
    pos += 8 + len;
  }
  for (const [id, [ci, off]] of Object.entries(index)) {
    const line = payloads[ci].slice(off).split('\n')[0];
    const rec = JSON.parse(line);
    assert.equal(rec.n.id, id);
  }
});

test('incremental decoder keeps the valid prefix queryable after corruption', () => {
  const g = sampleGraph(12); // several chunks
  const buf = encodeGraph(g, {});
  const good = decodeIncremental(buf);
  assert.ok(good.chunkCount >= 3, 'need multiple chunks for this test');

  // Flip a byte inside the payload of chunk 1 (the second chunk).
  const hlen = buf.readUInt32LE(4);
  let pos = 8 + hlen;
  const len0 = buf.readUInt32LE(pos);
  const chunk1Payload = pos + 8 + len0 + 8;
  const damaged = Buffer.from(buf);
  damaged[chunk1Payload] = damaged[chunk1Payload] ^ 0xff;

  const res = decodeIncremental(damaged);
  assert.equal(res.error.code, 'E_CORRUPT');
  assert.equal(res.error.chunk, 1);
  assert.equal(res.chunksRead, 1);
  // Prefix nodes (those indexed into chunk 0) are still queryable.
  const prefixNodes = Object.entries(good.meta.index)
    .filter(([, [ci]]) => ci === 0)
    .map(([id]) => id);
  assert.ok(prefixNodes.length > 0);
  for (const id of prefixNodes) {
    assert.ok(res.graph.nodes.has(id), `prefix node ${id} must be queryable`);
  }
  const laterNodes = Object.entries(good.meta.index)
    .filter(([, [ci]]) => ci > 0)
    .map(([id]) => id);
  assert.ok(laterNodes.length > 0);
  for (const id of laterNodes) {
    assert.ok(!res.graph.nodes.has(id), `node ${id} is past the corruption point`);
  }
});

test('truncated buffer yields E_CORRUPT with partial graph', () => {
  const g = sampleGraph(12);
  const buf = encodeGraph(g, {});
  const truncated = buf.subarray(0, buf.length - 3);
  const res = decodeIncremental(truncated);
  assert.equal(res.error.code, 'E_CORRUPT');
  assert.ok(res.chunksRead < res.chunkCount);
  assert.ok(res.graph.nodes.size > 0);
});
