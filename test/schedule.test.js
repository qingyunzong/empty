'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Archive } = require('../src/archive');

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('acceptance 1: restore matches brute-force max retention weight for n<=9', () => {
  for (let n = 1; n <= 9; n += 1) {
    for (let trial = 0; trial < 30; trial += 1) {
      const rand = lcg(n * 100000 + trial * 7919);
      const capacity = 10 + Math.floor(rand() * 40);
      const archive = new Archive({ stagingCapacity: capacity, bandwidthPerTick: 8 });
      const objs = [];
      for (let i = 0; i < n; i += 1) {
        const obj = {
          id: `o${i}`,
          size: 1 + Math.floor(rand() * 20),
          retention: 1 + Math.floor(rand() * 9),
          requester: `r${i % 3}`,
        };
        objs.push(obj);
        archive.request(obj);
      }
      const result = archive.restore();
      const restored = new Set(result.placement.map((p) => p.id));
      let value = 0;
      for (const obj of objs) {
        if (restored.has(obj.id)) value += obj.retention;
      }
      let best = 0;
      for (let mask = 0; mask < 2 ** n; mask += 1) {
        let size = 0;
        let val = 0;
        for (let i = 0; i < n; i += 1) {
          if (mask & (2 ** i)) {
            size += objs[i].size;
            val += objs[i].retention;
          }
        }
        if (size <= capacity && val > best) best = val;
      }
      assert.equal(value, best, `n=${n} trial=${trial} capacity=${capacity}`);
      assert.equal(value, result.value);
    }
  }
});

test('pending parent volume does not make child unrecoverable', () => {
  const archive = new Archive({ stagingCapacity: 100, bandwidthPerTick: 8 });
  archive.request({ id: 'parent', size: 10, retention: 5, requester: 'r1' });
  archive.request({ id: 'child', size: 10, retention: 9, requester: 'r1', parent: 'parent' });
  const first = archive.restore();
  assert.deepEqual(first.placement.map((p) => p.id), ['parent']);
  const child = archive.state.objects.child;
  assert.equal(child.status, 'pending');
  assert.equal(child.failReason, null);
  const second = archive.restore();
  assert.deepEqual(second.placement.map((p) => p.id), ['child']);
  assert.equal(archive.state.objects.child.status, 'staged');
});

test('bandwidth slices follow requester deficit fairness with wait cap', () => {
  const archive = new Archive({ stagingCapacity: 1000, bandwidthPerTick: 10, waitCap: 3 });
  archive.request({ id: 'a1', size: 40, retention: 5, requester: 'ra', quota: 1 });
  archive.request({ id: 'b1', size: 40, retention: 5, requester: 'rb', quota: 1 });
  const result = archive.restore();
  const total = result.slices.reduce((acc, s) => acc + s.bytes, 0);
  assert.equal(total, 80);
  const byRequester = { ra: 0, rb: 0 };
  for (const slice of result.slices) byRequester[slice.requester] += slice.bytes;
  assert.equal(byRequester.ra, 40);
  assert.equal(byRequester.rb, 40);
  // equal quotas: no requester may monopolize more than waitCap+burst consecutive ticks
  let run = 1;
  for (let i = 1; i < result.slices.length; i += 1) {
    if (result.slices[i].requester === result.slices[i - 1].requester) {
      run += 1;
      assert.ok(run <= 4, `run of ${run} slices for one requester`);
    } else {
      run = 1;
    }
  }
});

test('cyclic dependency raises CycleError', () => {
  const archive = new Archive({ stagingCapacity: 100 });
  archive.request({ id: 'x', size: 5, retention: 1, requester: 'r' });
  archive.request({ id: 'y', size: 5, retention: 1, requester: 'r', parent: 'x' });
  archive.state.objects.x.parent = 'y';
  assert.throws(() => archive.restore(), /cyclic dependency/);
});
