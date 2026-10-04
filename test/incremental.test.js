import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/graph.js';

function graph() {
  // s1 --+--> d1(sum) --> d3(sum)
  // s2 --+--> d2(min)
  // s3 (disconnected source), d4 isolated derived
  return new Engine({
    nodes: [
      { id: 's1', kind: 'source', value: 1 },
      { id: 's2', kind: 'source', value: 2 },
      { id: 's3', kind: 'source', value: 100 },
      { id: 'd1', kind: 'derived', op: 'sum', inputs: ['s1', 's2'] },
      { id: 'd2', kind: 'derived', op: 'min', inputs: ['s1', 's2'] },
      { id: 'd3', kind: 'derived', op: 'sum', inputs: ['d1'] },
      { id: 'd4', kind: 'derived', op: 'sum' },
    ],
  });
}

test('source update invalidates only its descendants', () => {
  const e = graph();
  const res = e.applyTransaction({ id: 't1', ops: [{ type: 'setSource', node: 's1', value: 10 }] });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.affected, ['d1', 'd2', 'd3']);
  assert.deepEqual(
    res.diffs.map((d) => [d.node, d.after.value]),
    [['s1', 10], ['d1', 12], ['d2', 2], ['d3', 12]],
  );
  // s3 has no descendants: nothing invalidated, but the source write is diffed
  const res2 = e.applyTransaction({ id: 't2', ops: [{ type: 'setSource', node: 's3', value: 0 }] });
  assert.deepEqual(res2.affected, []);
  assert.deepEqual(res2.diffs.map((d) => [d.node, d.after.value]), [['s3', 0]]);
});

test('after edge removal, old descendants are no longer invalidated', () => {
  const e = graph();
  const rm = e.applyTransaction({ id: 't1', ops: [{ type: 'removeEdge', from: 'd1', to: 'd3' }] });
  assert.deepEqual(rm.affected, ['d3']);
  assert.deepEqual(rm.diffs.map((d) => [d.node, d.after.value]), [['d3', 0]]);
  // Updating s1 now only reaches d1 and d2, not d3 via d1.
  const up = e.applyTransaction({ id: 't2', ops: [{ type: 'setSource', node: 's1', value: 5 }] });
  assert.deepEqual(up.affected, ['d1', 'd2']);
  assert.deepEqual(up.diffs.map((d) => [d.node, d.after.value]), [['s1', 5], ['d1', 7], ['d2', 2]]);
});

test('recompute order is topological with id-ascending ties', () => {
  const e = new Engine({
    nodes: [
      { id: 's', kind: 'source', value: 1 },
      { id: 'z', kind: 'derived', op: 'sum', inputs: ['s'] },
      { id: 'a', kind: 'derived', op: 'sum', inputs: ['s'] },
      { id: 'm', kind: 'derived', op: 'sum', inputs: ['a', 'z'] },
    ],
  });
  const res = e.applyTransaction({ id: 't', ops: [{ type: 'setSource', node: 's', value: 2 }] });
  assert.deepEqual(res.affected, ['a', 'z', 'm']);
});

test('no-op source write produces empty affected and diffs', () => {
  const e = graph();
  const res = e.applyTransaction({ id: 't', ops: [{ type: 'setSource', node: 's1', value: 1 }] });
  assert.deepEqual(res.affected, []);
  assert.deepEqual(res.diffs, []);
});

test('version certificate is deterministic and content-addressed', () => {
  const build = () => {
    const e = graph();
    e.applyTransaction({ id: 't1', undoTag: 'u1', ops: [{ type: 'setSource', node: 's1', value: 7 }] });
    return e;
  };
  const a = build();
  const b = build();
  assert.deepEqual(a.certificate(), b.certificate());
  assert.equal(a.certificate().version, 1);
  // Same content at the same version -> same digest, even via different paths.
  const c = graph();
  c.applyTransaction({ id: 'x', ops: [{ type: 'setSource', node: 's1', value: 9 }] });
  const d = graph();
  d.applyTransaction({ id: 'y', ops: [{ type: 'setSource', node: 's1', value: 9 }] });
  assert.equal(c.certificate().digest, d.certificate().digest);
});
