'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Frac } = require('../src/fraction.js');
const { Rect } = require('../src/geometry.js');
const { Workspace } = require('../src/workspace.js');

// Deterministic PRNG (mulberry32) for reproducible randomized checks.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference implementation: enumerate the elementary grid cells formed by
// every rectangle coordinate and sum cell areas by point membership.
function gridOverlapAreas(deviceRects, defectRect) {
  const xs = new Set();
  const ys = new Set();
  const all = [...deviceRects, defectRect];
  for (const r of all) {
    xs.add(r.x1.toString()); xs.add(r.x2.toString());
    ys.add(r.y1.toString()); ys.add(r.y2.toString());
  }
  const xCuts = [...xs].map(Frac.from).sort((a, b) => a.cmp(b));
  const yCuts = [...ys].map(Frac.from).sort((a, b) => a.cmp(b));
  const inside = (r, x, y) =>
    r.x1.cmp(x) <= 0 && x.cmp(r.x2) < 0 && r.y1.cmp(y) <= 0 && y.cmp(r.y2) < 0;
  const areas = deviceRects.map(() => Frac.zero());
  for (let i = 0; i + 1 < xCuts.length; i++) {
    for (let j = 0; j + 1 < yCuts.length; j++) {
      const mx = xCuts[i].add(xCuts[i + 1]).div(2);
      const my = yCuts[j].add(yCuts[j + 1]).div(2);
      if (!inside(defectRect, mx, my)) continue;
      const cellArea = xCuts[i + 1].sub(xCuts[i]).mul(yCuts[j + 1].sub(yCuts[j]));
      deviceRects.forEach((r, k) => {
        if (inside(r, mx, my)) areas[k] = areas[k].add(cellArea);
      });
    }
  }
  return areas;
}

function randomRect(rng, lo, hi, denom) {
  const steps = (hi - lo) * denom; // grid has steps+1 lattice points
  const pair = () => {
    const i = Math.floor(rng() * (steps + 1));
    let j = Math.floor(rng() * steps);
    if (j >= i) j += 1; // uniform distinct second index
    const a = new Frac(BigInt(lo * denom + Math.min(i, j)), BigInt(denom));
    const b = new Frac(BigInt(lo * denom + Math.max(i, j)), BigInt(denom));
    return [a, b];
  };
  const [x1, x2] = pair();
  const [y1, y2] = pair();
  return new Rect(x1, y1, x2, y2);
}

test('acceptance 1: n<=8 rects match grid enumeration for random rational layouts', () => {
  const rng = makeRng(20261002);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rng() * 8); // total rect count <= 8
    const defect = randomRect(rng, -4, 4, 4);
    const deviceRects = [];
    for (let k = 0; k < n - 1; k++) deviceRects.push(randomRect(rng, -4, 4, 4));
    const expected = gridOverlapAreas(deviceRects, defect);
    deviceRects.forEach((r, k) => {
      const actual = defect.overlapArea(r);
      assert.ok(actual.eq(expected[k]),
        `trial ${trial} rect ${k}: lib=${actual} grid=${expected[k]}`);
    });
  }
});

test('acceptance 2: shared-edge device has zero area and no responsibility', () => {
  const ws = Workspace.fromSpec({
    devices: [
      { id: 'left', rects: [[0, 0, 1, 2]] },
      { id: 'right', rects: [[1, 0, 3, 2]] }, // shares edge x=1 with defect
    ],
    defects: [{ id: 'd', rect: [1, 0, 3, 2] }],
  });
  const [d] = ws.report().defects;
  assert.equal(d.devices.length, 1);
  assert.equal(d.devices[0].deviceId, 'right');
  assert.equal(d.devices[0].overlapArea, '4');
  assert.equal(d.devices[0].ratio, '1');
  assert.deepEqual(d.responsible, ['right']);
});

test('acceptance 3: two devices covering half each are both responsible (tie)', () => {
  const ws = Workspace.fromSpec({
    devices: [
      { id: 'A', rects: [[0, 0, 2, 2]] },
      { id: 'B', rects: [[2, 0, 4, 2]] },
    ],
    defects: [{ id: 'd', rect: [1, 0, 3, 2] }],
  });
  const [d] = ws.report().defects;
  assert.equal(d.totalArea, '4');
  assert.equal(d.devices[0].overlapArea, '2');
  assert.equal(d.devices[1].overlapArea, '2');
  assert.equal(d.devices[0].ratio, '1/2');
  assert.equal(d.devices[1].ratio, '1/2');
  assert.deepEqual(d.responsible, ['A', 'B']);
});

test('acceptance 4: illegal scale rolls back and leaves undo stack unchanged', () => {
  const ws = Workspace.fromSpec({
    devices: [{ id: 'A', rects: [[0, 0, 4, 4]] }],
    defects: [{ id: 'd', rect: [1, 1, 3, 3] }],
  });
  ws.moveDefect('d', '1/2', 0); // one legal transaction on the undo stack
  const undoDepth = ws.undoStack.length;
  const before = ws.defects.get('d').toArray();

  for (const badFactor of ['0', '-1/2', 0, -2]) {
    assert.throws(() => ws.scaleDefect('d', badFactor), (err) => err.rolledBack === true);
    assert.equal(ws.undoStack.length, undoDepth);
    assert.deepEqual(ws.defects.get('d').toArray(), before);
  }
  // Illegal coordinates also roll back.
  assert.throws(() => ws.moveDefect('d', 'not-a-number', 0), (err) => err.rolledBack === true);
  assert.equal(ws.undoStack.length, undoDepth);
  assert.deepEqual(ws.defects.get('d').toArray(), before);
});

test('containment: device fully containing defect gets ratio 1', () => {
  const ws = Workspace.fromSpec({
    devices: [{ id: 'big', rects: [[0, 0, 10, 10]] }],
    defects: [{ id: 'd', rect: ['1/2', '1/3', '5/2', '7/3'] }],
  });
  const [d] = ws.report().defects;
  assert.equal(d.totalArea, '4'); // 2 * 2
  assert.equal(d.devices[0].overlapArea, '4');
  assert.equal(d.devices[0].ratio, '1');
  assert.deepEqual(d.responsible, ['big']);
});

test('undo/redo restore committed states', () => {
  const ws = Workspace.fromSpec({
    devices: [{ id: 'A', rects: [[0, 0, 10, 10]] }],
    defects: [{ id: 'd', rect: [0, 0, 2, 2] }],
  });
  ws.moveDefect('d', 1, 0);
  ws.moveDefect('d', 0, 1);
  assert.deepEqual(ws.defects.get('d').toArray(), ['1', '1', '3', '3']);
  assert.ok(ws.undo());
  assert.deepEqual(ws.defects.get('d').toArray(), ['1', '0', '3', '2']);
  assert.ok(ws.undo());
  assert.deepEqual(ws.defects.get('d').toArray(), ['0', '0', '2', '2']);
  assert.ok(!ws.undo());
  assert.ok(ws.redo());
  assert.deepEqual(ws.defects.get('d').toArray(), ['1', '0', '3', '2']);
  // A new transaction clears the redo stack.
  ws.moveDefect('d', 0, 5);
  assert.ok(!ws.redo());
});

test('split produces two defects whose areas sum to the original', () => {
  const ws = Workspace.fromSpec({
    devices: [{ id: 'A', rects: [[0, 0, 10, 10]] }],
    defects: [{ id: 'd', rect: [0, 0, 4, 2] }],
  });
  ws.splitDefect('d', 'x', '3/2', 'd2');
  const report = ws.report().defects;
  assert.equal(report.length, 2);
  const areas = report.map((r) => Frac.from(r.totalArea));
  assert.ok(areas[0].add(areas[1]).eq(Frac.from(8)));
  // Split outside the interior rolls back.
  const depth = ws.undoStack.length;
  assert.throws(() => ws.splitDefect('d', 'x', 99), (err) => err.rolledBack === true);
  assert.equal(ws.undoStack.length, depth);
});

test('certificate cut intervals tile the overlap rectangle exactly', () => {
  const ws = Workspace.fromSpec({
    devices: [
      { id: 'A', rects: [[0, 0, '5/2', 3]] },
      { id: 'B', rects: [['3/2', 1, 4, 4]] },
    ],
    defects: [{ id: 'd', rect: [1, '1/2', 3, '7/2'] }],
  });
  const [d] = ws.report().defects;
  assert.ok(d.certificates.length > 0);
  for (const cert of d.certificates) {
    let area = Frac.zero();
    for (const [xa, xb] of cert.xIntervals) {
      for (const [ya, yb] of cert.yIntervals) {
        area = area.add(Frac.from(xb).sub(xa).mul(Frac.from(yb).sub(ya)));
      }
    }
    assert.ok(area.eq(Frac.from(cert.area)), `certificate area mismatch: ${area} vs ${cert.area}`);
  }
});
