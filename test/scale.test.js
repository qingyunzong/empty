import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Monitor } from '../src/monitor.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('scale: n=300, m<=2000, 8000 operations with queries and recovery', () => {
  const rnd = mulberry32(7);
  const N = 300;
  const MAX_M = 2000;
  const OPS = 8000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-scale-'));
  const log = path.join(dir, 'ops.jsonl');
  let m = new Monitor(log);
  const mirror = new Set();
  const key = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);

  let adds = 0;
  let dels = 0;
  for (let i = 0; i < OPS; i += 1) {
    const u = Math.floor(rnd() * N);
    let v = Math.floor(rnd() * N);
    if (u === v) v = (v + 1) % N;
    const k = key(u, v);
    const wantDel = mirror.has(k) && (rnd() < 0.5 || mirror.size >= MAX_M);
    if (wantDel) {
      assert.equal(m.delEdge(u, v), 'OK');
      mirror.delete(k);
      dels += 1;
    } else if (!mirror.has(k) && mirror.size < MAX_M) {
      assert.equal(m.addEdge(u, v), 'OK');
      mirror.add(k);
      adds += 1;
    }
    if (i % 100 === 99) {
      // queries must stay consistent with the mirror edge set
      assert.equal(m.graph.edgeCount(), mirror.size);
      m.queryBridges();
      m.queryArticulation();
    }
    if (i % 1000 === 999) {
      m.commit();
      const recovered = new Monitor(log);
      assert.equal(recovered.graph.edgeCount(), mirror.size);
      assert.equal(recovered.stateHash(), m.stateHash());
      m = recovered;
    }
  }
  assert.ok(adds > 0 && dels > 0, 'both insertions and deletions exercised');
  assert.ok(mirror.size <= MAX_M);

  // final full recovery agrees with the live view
  m.commit();
  const stats = new Monitor(log, { autoRecover: false }).recover();
  assert.equal(stats.discarded, 0);
  assert.equal(stats.state_hash, m.stateHash());
  assert.ok(stats.applied <= OPS + 1); // data records only, commits excluded
});
