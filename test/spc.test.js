'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SPC } = require('../src/spc');
const { recompute } = require('../src/reference');
const { FaultInjector, mulberry32 } = require('../src/faults');

function makeStream(n, { seed = 7, shiftAt = 150, shiftLen = 12, shift = 9 } = {}) {
  const rng = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let v = 100 + (rng() + rng() + rng() - 1.5) * 4; // approx N(100, 2)
    if (i >= shiftAt && i < shiftAt + shiftLen) v += shift;
    pts.push({ id: `p${i}`, value: v });
  }
  return pts;
}

function fill(spc, points) {
  for (const p of points) spc.insert(p);
  return spc;
}

function compareToReference(spc) {
  const ref = recompute(spc.snapshot());
  const got = spc.alarms().map((a) => ({ rule: a.rule, triggerId: a.trigger, side: a.side }));
  assert.deepEqual(got, ref.alarms, 'alarm list mismatch vs brute-force reference');
  for (const [id, st] of ref.statuses) {
    assert.equal(spc.statusOf(id), st, `status mismatch for ${id}`);
  }
  const gl = spc.controlLimits();
  const rl = ref.controlLimits;
  assert.equal(gl.status, rl.status, 'controlLimits status mismatch');
  if (gl.limits) {
    assert.ok(Math.abs(gl.limits.mean - rl.limits.mean) < 1e-9, 'mean mismatch');
    assert.ok(Math.abs(gl.limits.sigma - rl.limits.sigma) < 1e-9, 'sigma mismatch');
  }
  assert.equal(spc.status(), ref.status, 'overall status mismatch');
  return ref;
}

test('acceptance 1: 200-point random stream matches naive reference', () => {
  const spc = fill(new SPC({ windowSize: 50, minSamples: 10 }), makeStream(200));
  const ref = compareToReference(spc);
  assert.ok(ref.alarms.length > 0, 'expected the injected shift to raise alarms');
});

test('acceptance 2: correcting a historical point matches full recompute', () => {
  const points = makeStream(200);
  const spc = fill(new SPC({ windowSize: 50, minSamples: 10 }), points);
  const original = points[40].value;

  spc.correct('p40', 130); // wild correction deep in history
  compareToReference(spc);

  spc.correct('p40', original); // correct it back
  compareToReference(spc);

  spc.correct('p199', 60); // correction at the tail
  compareToReference(spc);
});

test('acceptance 3: unit injection yields reproducible ERR_UNIT flags', () => {
  const config = { unit: 'mm', windowSize: 200, minSamples: 20 };
  const points = makeStream(200);

  const build = () => {
    const injector = new FaultInjector({ seed: 99 });
    injector.injectUnit('p100', 'in').drop('p120').reorder(130, 140);
    return injector;
  };

  const spc1 = new SPC(config);
  const log = build().run(points, spc1);

  const spc2 = new SPC(config);
  FaultInjector.replay(log, points, spc2);

  // reproducible: identical alarms (incl. minimal subsets) and flags
  assert.deepEqual(spc1.alarms(), spc2.alarms());
  assert.deepEqual(spc1.point('p100').flags, spc2.point('p100').flags);

  // unit fault is flagged and excluded from statistics
  assert.ok(spc1.point('p100').flags.includes('ERR_UNIT'));
  assert.equal(spc1.point('p100').status, 'EXCLUDED');
  assert.equal(spc1.point('p120'), undefined, 'dropped point never inserted');

  // alarms after the fault see it inside their baseline window
  assert.ok(
    spc1.alarms().some((a) => a.explanation.unitError && a.explanation.unitPoints.includes('p100')),
    'expected at least one alarm explained by the unit fault',
  );

  // JSON round-trip of the log replays identically
  const spc3 = new SPC(config);
  FaultInjector.replay(JSON.parse(JSON.stringify(log)), points, spc3);
  assert.deepEqual(spc1.alarms(), spc3.alarms());
});

test('acceptance 4: insufficient samples report UNKNOWN, never a false OK', () => {
  const spc = new SPC({ minSamples: 5 });
  assert.equal(spc.status(), 'UNKNOWN'); // empty
  spc.insert({ id: 'a', value: 1 });
  assert.equal(spc.status(), 'UNKNOWN'); // single point
  assert.equal(spc.statusOf('a'), 'UNKNOWN');
  spc.insert({ id: 'b', value: 2 });
  spc.insert({ id: 'c', value: 3 });
  assert.equal(spc.status(), 'UNKNOWN'); // 3 < 5
  assert.deepEqual(spc.alarms(), []);
  const cl = spc.controlLimits();
  assert.equal(cl.status, 'UNKNOWN');
  assert.equal(cl.limits, null);
});

test('edge: all points invalidated -> UNKNOWN, no alarms', () => {
  const spc = fill(new SPC({ minSamples: 5 }), makeStream(20, { shiftAt: 1000 }));
  spc.invalidate('p0', 'p19');
  assert.equal(spc.status(), 'UNKNOWN');
  assert.deepEqual(spc.alarms(), []);
  assert.equal(spc.controlLimits().status, 'UNKNOWN');
  assert.equal(spc.statusOf('p7'), 'EXCLUDED');
});

test('edge: constant stream has sigma 0; a single deviation trips WE1', () => {
  const spc = new SPC({ minSamples: 10, windowSize: 50 });
  for (let i = 0; i < 30; i++) spc.insert({ id: `c${i}`, value: 5 });
  assert.equal(spc.status(), 'IN_CONTROL');
  assert.equal(spc.controlLimits().limits.sigma, 0);
  assert.deepEqual(spc.alarms(), []);

  const res = spc.insert({ id: 'outlier', value: 6 });
  assert.equal(res.status, 'ALARM');
  const alarms = spc.alarms();
  assert.ok(alarms.some((a) => a.rule === 'WE1' && a.trigger === 'outlier'));
  const we1 = alarms.find((a) => a.rule === 'WE1');
  assert.deepEqual(we1.subset, ['outlier']);

  spc.insert({ id: 'back', value: 5 }); // no crash returning to constant
  compareToReference(spc);
});

test('invalidate(range) matches brute-force reference and explains data gaps', () => {
  const spc = fill(new SPC({ windowSize: 50, minSamples: 10 }), makeStream(200));
  assert.equal(spc.invalidate('p100', 'p110'), 11);
  compareToReference(spc);
  const gapAlarms = spc.alarms().filter((a) => a.explanation.dataGap);
  assert.ok(gapAlarms.length > 0, 'expected alarms whose span contains the invalidated range');
  assert.ok(gapAlarms.every((a) => a.explanation.gapPoints.includes('p105')));
});

test('minimal triggering subset: deleting any subset point kills the alarm', () => {
  const spc = fill(new SPC({ windowSize: 50, minSamples: 10 }), makeStream(200));
  const snap = spc.snapshot();
  const refFull = recompute(snap);
  const alarms = spc.alarms();
  assert.ok(alarms.length > 0);
  for (const alarm of alarms.slice(0, 25)) {
    assert.ok(alarm.subset.length >= 1);
    assert.ok(alarm.subset.includes(alarm.trigger));
    // alarm exists on the full stream per the independent reference
    assert.ok(
      refFull.alarms.some((x) => x.rule === alarm.rule && x.triggerId === alarm.trigger && x.side === alarm.side),
    );
    for (const id of alarm.subset) {
      const reduced = recompute({ ...snap, points: snap.points.filter((p) => p.id !== id) });
      assert.ok(
        !reduced.alarms.some((x) => x.rule === alarm.rule && x.triggerId === alarm.trigger && x.side === alarm.side),
        `alarm ${alarm.rule}@${alarm.trigger} should vanish after deleting ${id}`,
      );
    }
  }
});

test('out-of-order (reorder) injection still matches reference', () => {
  const config = { windowSize: 50, minSamples: 10 };
  const points = makeStream(200);
  const injector = new FaultInjector({ seed: 5 });
  injector.reorder(20, 45).reorder(150, 165);
  const spc = new SPC(config);
  const log = injector.run(points, spc);
  compareToReference(spc);

  const spc2 = new SPC(config);
  FaultInjector.replay(log, points, spc2);
  assert.deepEqual(spc.alarms(), spc2.alarms());
});

test('configurable rule subsets and custom rules match reference', () => {
  const points = makeStream(200);
  const onlyWe1 = fill(new SPC({ rules: ['WE1'], windowSize: 50, minSamples: 10 }), points);
  compareToReference(onlyWe1);
  assert.ok(onlyWe1.alarms().every((a) => a.rule === 'WE1'));

  const custom = fill(
    new SPC({
      rules: ['WE4', { name: 'TIGHT', type: 'beyond', k: 2, m: 2, sigma: 1 }, { name: 'RUN5', type: 'run', run: 5 }],
      windowSize: 40,
      minSamples: 8,
    }),
    points,
  );
  compareToReference(custom);
});

test('known unit conversions convert and flag instead of ERR_UNIT', () => {
  const spc = new SPC({ unit: 'mm', conversions: { in: 25.4 }, minSamples: 3, windowSize: 10 });
  spc.insert({ id: 'a', value: 10 });
  spc.insert({ id: 'b', value: 10 });
  spc.insert({ id: 'c', value: 10 });
  const r = spc.insert({ id: 'd', value: 10 / 25.4, unit: 'in' }); // = 10mm
  assert.equal(r.status, 'IN_CONTROL');
  assert.ok(spc.point('d').flags.includes('UNIT_CONVERTED'));
  assert.ok(Math.abs(spc.point('d').value - 10) < 1e-12);
  spc.insert({ id: 'e', value: 5, unit: 'furlong' });
  assert.ok(spc.point('e').flags.includes('ERR_UNIT'));
});
