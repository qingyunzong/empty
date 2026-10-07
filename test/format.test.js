import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/graph.js';
import { encodeGraph, decodeIncremental, decode, getNode } from '../src/format.js';
import { findBestPath } from '../src/scheduler.js';

function sampleGraph() {
  return Graph.fromJSON({
    devices: [
      { id: 'mill', capacity: 10 },
      { id: 'lathe', capacity: 6 },
    ],
    nodes: [
      { id: 'A', device: 'mill', time: 3, load: 2 },
      { id: 'B', device: 'lathe', time: 2, load: 3 },
      { id: 'C', device: 'mill', time: 4, load: 5 },
      { id: 'D', device: 'lathe', time: 1, load: 1 },
      { id: 'E', device: 'mill', time: 2, load: 2 },
    ],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
      { from: 'D', to: 'E' },
    ],
  });
}

test('encode/decode roundtrip preserves the graph', () => {
  const g = sampleGraph();
  const buf = encodeGraph(g, { chunkSize: 2 });
  const res = decodeIncremental(buf);
  assert.equal(res.complete, true);
  assert.equal(res.corruptedAt, null);
  assert.deepEqual(res.graph.toJSON(), g.toJSON());
});

test('index stores an offset for every node and getNode resolves it', () => {
  const g = sampleGraph();
  const buf = encodeGraph(g, { chunkSize: 2 });
  const res = decode(buf);
  const ids = res.index.entries.map((e) => e.id).sort();
  assert.deepEqual(ids, g.nodeIds());
  for (const id of g.nodeIds()) {
    const rec = getNode(buf, id);
    assert.equal(rec.node.id, id);
    assert.deepEqual(rec.node, g.nodes.get(id));
    assert.deepEqual([...rec.edges].sort(), g.neighbors(id));
  }
  assert.equal(getNode(buf, 'ZZZ'), null);
});

test('corrupted later block keeps the common prefix queryable', () => {
  const g = sampleGraph();
  const buf = encodeGraph(g, { chunkSize: 1 });
  const res0 = decodeIncremental(buf);
  const lastNodeBlock = res0.blocks.filter((b) => b.type === 3).at(-1);
  const corrupted = Buffer.from(buf);
  corrupted[lastNodeBlock.offset + 10] ^= 0xff;

  const res = decodeIncremental(corrupted);
  assert.equal(res.complete, false);
  assert.equal(res.corruptedAt, lastNodeBlock.index);
  assert.equal(res.blocks.length, lastNodeBlock.index);
  assert.deepEqual(res.graph.nodeIds(), ['A', 'B', 'C', 'D']);

  const best = findBestPath(res.graph, 'A', 'D');
  assert.deepEqual(best.path, ['A', 'B', 'D']);
  assert.equal(best.time, 6);

  assert.equal(getNode(corrupted, 'A').node.id, 'A');
  assert.throws(() => getNode(corrupted, 'E'), /E_CORRUPT|crc/);
});

test('strict decode rejects corrupted buffers', () => {
  const buf = encodeGraph(sampleGraph(), { chunkSize: 2 });
  const corrupted = Buffer.from(buf);
  corrupted[corrupted.length - 6] ^= 0x01;
  assert.throws(() => decode(corrupted), (err) => err.code === 'E_CORRUPT');
});
