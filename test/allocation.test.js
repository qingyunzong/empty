import test from 'node:test';
import assert from 'node:assert/strict';
import { Fraction, IllegalCoordinateError } from '../src/fraction.js';
import { Rect } from '../src/rect.js';
import { AllocationEngine } from '../src/allocation.js';
import { runJson } from '../src/run-commands.js';

// Deterministic PRNG (mulberry32) so the grid cross-check is reproducible.
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference implementation: build the grid from every rectangle coordinate,
// then attribute each non-empty cell (via its midpoint, half-open semantics)
// to the single device covering it, restricted to the defect block.
function gridAreas(deviceRects, defectRect) {
  const xs = new Set();
  const ys = new Set();
  const collect = (rect) => {
    xs.add(rect.x1.toString());
    xs.add(rect.x2.toString());
    ys.add(rect.y1.toString());
    ys.add(rect.y2.toString());
  };
  deviceRects.forEach((rects) => rects.forEach(collect));
  collect(defectRect);
  const sortFr = (a, b) => Fraction.parse(a).cmp(Fraction.parse(b));
  const gx = [...xs].sort(sortFr).map(Fraction.parse);
  const gy = [...ys].sort(sortFr).map(Fraction.parse);
  const areas = new Map();
  for (let i = 0; i + 1 < gx.length; i += 1) {
    for (let j = 0; j + 1 < gy.length; j += 1) {
      const cell = new Rect(gx[i], gy[j], gx[i + 1], gy[j + 1]);
      const midX = cell.x1.add(cell.x2).div(2);
      const midY = cell.y1.add(cell.y2).div(2);
      if (!defectRect.containsPoint(midX, midY)) continue;
      for (const [deviceId, rects] of deviceRects) {
        if (rects.some((rect) => rect.containsPoint(midX, midY))) {
          areas.set(deviceId, (areas.get(deviceId) ?? Fraction.ZERO).add(cell.area()));
          break;
        }
      }
    }
  }
  return areas;
}

test('fraction: parsing, normalization, arithmetic', () => {
  assert.equal(Fraction.parse('6/8').toString(), '3/4');
  assert.equal(Fraction.parse('-2/-4').toString(), '1/2');
  assert.equal(Fraction.parse('0.5').toString(), '1/2');
  assert.equal(Fraction.parse(0.1).add(Fraction.parse(0.2)).toString(), '3/10');
  assert.equal(Fraction.parse({ num: 4, den: '6' }).toString(), '2/3');
  assert.equal(Fraction.parse('1e-2').toString(), '1/100');
  assert.equal(Fraction.parse('2/3').mul('9/4').toString(), '3/2');
  assert.equal(Fraction.parse('1/2').cmp('2/3'), -1);
  assert.throws(() => Fraction.parse('1/0'), IllegalCoordinateError);
  assert.throws(() => Fraction.parse(Number.NaN), IllegalCoordinateError);
  assert.throws(() => Fraction.parse(Infinity), IllegalCoordinateError);
});

test('half-open bounds: shared edge has zero overlap, containment is exact', () => {
  const a = new Rect(0, 0, 1, 1);
  const b = new Rect(1, 0, 2, 1); // shares edge x=1 with a
  assert.equal(a.intersect(b), null);
  const container = new Rect(0, 0, 10, 10);
  const inner = new Rect('1/2', '1/4', '3/2', '5/4');
  const overlap = container.intersect(inner);
  assert.equal(overlap.area().toString(), inner.area().toString());
  assert.equal(inner.area().toString(), '1/1');
});

test('acceptance 2: edge-touching device gets zero area and no responsibility', () => {
  const engine = new AllocationEngine();
  assert.ok(engine.addDevice('devA', { x1: 0, y1: 0, x2: 1, y2: 1 }).ok);
  assert.ok(engine.addDevice('devB', { x1: 1, y1: 0, x2: 2, y2: 1 }).ok);
  assert.ok(engine.addDefect('d1', { x1: 0, y1: 0, x2: 1, y2: 1 }).ok);
  const [block] = engine.report().blocks;
  assert.equal(block.devices.length, 1);
  assert.equal(block.devices[0].deviceId, 'devA');
  assert.equal(block.devices[0].area.toString(), '1/1');
  assert.equal(block.totalArea.toString(), '1/1');
  assert.equal(block.devices[0].ratio.toString(), '1/1');
  assert.deepEqual(block.responsible, ['devA']);
});

test('acceptance 3: two devices covering half each are tied', () => {
  const engine = new AllocationEngine();
  engine.addDevice('devA', { x1: 0, y1: 0, x2: 1, y2: 1 });
  engine.addDevice('devB', { x1: 1, y1: 0, x2: 2, y2: 1 });
  engine.addDefect('d1', { x1: 0, y1: 0, x2: 2, y2: 1 });
  const [block] = engine.report().blocks;
  assert.equal(block.totalArea.toString(), '2/1');
  assert.deepEqual(
    block.devices.map((d) => [d.deviceId, d.ratio.toString()]),
    [['devA', '1/2'], ['devB', '1/2']],
  );
  assert.deepEqual(block.responsible, ['devA', 'devB']);
});

test('certificates carry x/y split intervals of the overlap', () => {
  const engine = new AllocationEngine();
  engine.addDevice('devA', { x1: 0, y1: 0, x2: 4, y2: 4 });
  engine.addDefect('d1', { x1: '3/2', y1: 1, x2: 3, y2: '7/2' });
  const [block] = engine.report().blocks;
  const [cert] = block.devices[0].certificates;
  assert.deepEqual(cert.xInterval.map(String), ['3/2', '3/1']);
  assert.deepEqual(cert.yInterval.map(String), ['1/1', '7/2']);
  assert.equal(cert.area.toString(), '15/4');
  assert.equal(block.defectArea.toString(), '15/4');
});

test('acceptance 4: illegal scale rolls back, undo stack untouched', () => {
  const engine = new AllocationEngine();
  engine.addDevice('devA', { x1: 0, y1: 0, x2: 10, y2: 10 });
  engine.addDefect('d1', { x1: 1, y1: 1, x2: 3, y2: 3 });
  assert.ok(engine.moveDefect('d1', 1, 0).ok);
  const depthBefore = engine.undoDepth;
  const failed = engine.scaleDefect('d1', 0, 2);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /positive/);
  assert.equal(engine.undoDepth, depthBefore); // undo stack unchanged
  assert.equal(engine.redoDepth, 0);
  // State unchanged: defect still at the moved position.
  const [block] = engine.defectBlocks('d1');
  assert.equal(block.x1.toString(), '2/1');
  assert.equal(block.x2.toString(), '4/1');
  // Undo still reverts the last good transaction (the move).
  assert.ok(engine.undo().ok);
  const [restored] = engine.defectBlocks('d1');
  assert.equal(restored.x1.toString(), '1/1');
  assert.ok(engine.redo().ok);
  assert.equal(engine.defectBlocks('d1')[0].x1.toString(), '2/1');
});

test('illegal coordinates and empty rects roll back', () => {
  const engine = new AllocationEngine();
  engine.addDefect('d1', { x1: 0, y1: 0, x2: 2, y2: 2 });
  const depth = engine.undoDepth;
  assert.equal(engine.addDefect('bad', { x1: 1, y1: 1, x2: 1, y2: 2 }).ok, false);
  assert.equal(engine.addDevice('dev', { x1: 0, y1: 0, x2: 1, y2: 1 / 0 }).ok, false);
  assert.equal(engine.moveDefect('d1', 'abc', 0).ok, false);
  assert.equal(engine.splitDefect('d1', 'x', 2).ok, false); // cut on boundary
  assert.equal(engine.splitDefect('d1', 'x', 5).ok, false); // cut outside
  assert.equal(engine.undoDepth, depth);
  assert.equal(engine.defectBlocks('d1').length, 1);
});

test('split produces two blocks whose areas sum to the original; undo/redo works', () => {
  const engine = new AllocationEngine();
  engine.addDevice('devA', { x1: 0, y1: 0, x2: 2, y2: 2 });
  engine.addDevice('devB', { x1: 2, y1: 0, x2: 4, y2: 2 });
  engine.addDefect('d1', { x1: 0, y1: 0, x2: 4, y2: 2 });
  const split = engine.splitDefect('d1', 'x', '3/2');
  assert.ok(split.ok);
  const blocks = engine.report().blocks;
  assert.equal(blocks.length, 2);
  const total = blocks.reduce((acc, b) => acc.add(b.defectArea), Fraction.ZERO);
  assert.equal(total.toString(), '8/1');
  assert.deepEqual(blocks[0].responsible, ['devA']);
  assert.deepEqual(blocks[1].responsible, ['devB']);
  assert.ok(engine.undo().ok);
  assert.equal(engine.report().blocks.length, 1);
  assert.ok(engine.redo().ok);
  assert.equal(engine.report().blocks.length, 2);
});

test('acceptance 1: grid enumeration cross-check for n <= 8 rectangles', () => {
  const rng = makeRng(20261003);
  for (let iter = 0; iter < 100; iter += 1) {
    const coord = () => `${Math.floor(rng() * 6)}/${1 + Math.floor(rng() * 3)}`;
    const randRect = () => {
      const x1 = Fraction.parse(coord());
      const y1 = Fraction.parse(coord());
      const x2 = x1.add(Fraction.parse(coord()).add(Fraction.ONE));
      const y2 = y1.add(Fraction.parse(coord()).add(Fraction.ONE));
      return new Rect(x1, y1, x2, y2);
    };
    const deviceCount = 1 + Math.floor(rng() * 8); // 1..8 device rectangles
    const engine = new AllocationEngine();
    const deviceRects = new Map();
    for (let i = 0; i < deviceCount; i += 1) {
      const rect = randRect();
      const id = `dev${i}`;
      // Devices may not overlap each other for the reference to be exact;
      // skip overlapping pairs by giving each device its own x-slab instead.
      const shifted = rect.translate(Fraction.parse(i * 20), 0);
      deviceRects.set(id, [shifted]);
      assert.ok(engine.addDevice(id, shifted).ok);
    }
    const defect = randRect().translate(Fraction.parse(Math.floor(rng() * deviceCount) * 20 - 10), 0);
    assert.ok(engine.addDefect('d1', defect).ok);
    const expected = gridAreas(deviceRects, defect);
    const [block] = engine.report().blocks;
    const actual = new Map(block.devices.map((d) => [d.deviceId, d.area]));
    assert.equal(actual.size, expected.size, `iter ${iter}: device count mismatch`);
    let sum = Fraction.ZERO;
    for (const [id, area] of expected) {
      assert.ok(actual.has(id), `iter ${iter}: missing ${id}`);
      assert.equal(actual.get(id).toString(), area.toString(), `iter ${iter}: area of ${id}`);
      sum = sum.add(area);
    }
    assert.equal(block.totalArea.toString(), sum.toString(), `iter ${iter}: total`);
    // Tied maxima: reference check that `responsible` is exactly the tie set.
    if (block.devices.length > 0) {
      const maxRatio = block.devices.reduce((m, d) => (d.ratio.cmp(m) > 0 ? d.ratio : m), block.devices[0].ratio);
      const expectedTies = block.devices.filter((d) => d.ratio.cmp(maxRatio) === 0).map((d) => d.deviceId);
      assert.deepEqual([...block.responsible].sort(), expectedTies.sort(), `iter ${iter}: ties`);
    }
  }
});

test('undo/redo across a sequence of committed transactions', () => {
  const engine = new AllocationEngine();
  engine.addDefect('d1', { x1: 0, y1: 0, x2: 2, y2: 2 });
  engine.moveDefect('d1', 1, 1);
  engine.scaleDefect('d1', 2, 2);
  assert.equal(engine.defectBlocks('d1')[0].x2.toString(), '5/1');
  engine.undo();
  assert.equal(engine.defectBlocks('d1')[0].x2.toString(), '3/1');
  engine.undo();
  assert.equal(engine.defectBlocks('d1')[0].x1.toString(), '0/1');
  assert.equal(engine.undo().ok, true); // undoes addDefect
  assert.equal(engine.defectIds().length, 0);
  assert.equal(engine.undo().ok, false);
  engine.redo();
  engine.redo();
  engine.redo();
  assert.equal(engine.defectBlocks('d1')[0].x2.toString(), '5/1');
  assert.equal(engine.redo().ok, false);
});

test('CLI: JSON command document end-to-end, including rollback and ties', () => {
  const input = {
    commands: [
      { op: 'addDevice', id: 'devA', rect: { x1: 0, y1: 0, x2: 1, y2: 1 } },
      { op: 'addDevice', id: 'devB', rect: { x1: 1, y1: 0, x2: 2, y2: 1 } },
      { op: 'addDefect', id: 'd1', rect: { x1: 0, y1: 0, x2: 2, y2: 1 } },
      { op: 'scaleDefect', id: 'd1', sx: 0, sy: 1 },
      { op: 'splitDefect', id: 'd1', axis: 'x', at: '1/2' },
      { op: 'undo' },
      { op: 'report' },
    ],
  };
  // Same code path as cli.js, which feeds stdin text into runJson.
  const output = JSON.parse(JSON.stringify(runJson(JSON.stringify(input))));
  assert.equal(output.results.length, 7);
  assert.equal(output.results[3].ok, false); // illegal scale rolled back
  assert.match(output.results[3].error, /positive/);
  assert.equal(output.results[4].ok, true); // split committed
  assert.equal(output.results[5].ok, true); // undo removes the split
  const block = output.report.blocks[0];
  assert.equal(block.totalArea, '2/1');
  assert.deepEqual(block.responsible, ['devA', 'devB']); // tie, both listed
  const cert = block.devices[0].certificates[0];
  assert.deepEqual(cert.xInterval, ['0/1', '1/1']);
  assert.equal(cert.area, '1/1');
});
