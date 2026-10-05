'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const {
  referenceInversions,
  referenceMaxInversion,
  referenceMissing,
} = require('./reference');

const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const HALF_HOUR = 30 * 60 * 1000;

function upsert(profileId, depth, temp, version, timeMs) {
  return { type: 'UPSERT', profileId, depth, temp, version, time: timeMs };
}

function retract(profileId, depth, version, timeMs) {
  return { type: 'RETRACT', profileId, depth, version, time: timeMs };
}

function watermark(timeMs) {
  return { type: 'WATERMARK', time: timeMs };
}

function run(engine, events) {
  const outputs = [];
  const errors = [];
  for (const event of events) {
    const result = engine.apply(event);
    outputs.push(...result.outputs);
    errors.push(...result.errors);
  }
  return { outputs, errors };
}

test('acceptance: depths arriving in reverse order yield correct inversion layer', () => {
  const engine = new Engine();
  const events = [];
  // 10 depths, deepest first; temp rises 1.0C per 10m of depth -> every adjacent
  // pair is an inversion, layer spans the whole profile.
  for (let i = 0; i < 10; i++) {
    const depth = 100 - i * 10;
    events.push(upsert('p1', depth, 10 + depth * 0.1, 1, T0 + i * 1000));
  }
  events.push(watermark(T0 + 10 * 1000 + HALF_HOUR + 1));
  const { outputs, errors } = run(engine, events);
  assert.equal(errors.length, 0);

  const cert = outputs.find((o) => o.type === 'CERTIFICATE');
  assert.ok(cert, 'certificate published');
  assert.equal(cert.profileId, 'p1');
  assert.deepEqual(cert.depths, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);

  const points = cert.depths.map((d) => ({ depth: d, temp: 10 + d * 0.1 }));
  assert.deepEqual(cert.inversions, referenceInversions(points));
  assert.equal(cert.inversions.length, 9);
  assert.deepEqual(cert.maxInversion, referenceMaxInversion(points));
  assert.deepEqual(cert.maxInversion, { top: 10, bottom: 100, span: 90 });
  assert.deepEqual(cert.missing, referenceMissing(points));
  assert.equal(cert.missing.blockCount, 9);
  assert.deepEqual(cert.missing.blocks[0], [11, 19]);
});

test('acceptance: retracting a middle depth merges missing blocks and removes inversion', () => {
  const engine = new Engine();
  const { errors: e1 } = run(engine, [
    upsert('p1', 10, 20, 1, T0),
    upsert('p1', 12, 21, 1, T0 + 1000), // inversion vs depth 10 (rise 1.0C)
    upsert('p1', 14, 15, 1, T0 + 2000),
  ]);
  assert.equal(e1.length, 0);

  // Before retract: two 1m missing blocks, one inversion pair.
  let profile = engine.profiles.get('p1');
  let cert = profile.certificate();
  assert.deepEqual(cert.inversions, [[10, 12]]);
  assert.deepEqual(cert.missing.blocks, [[11, 11], [13, 13]]);

  // Retract the middle point: neighbours 10 and 14 become adjacent; their
  // pair is not an inversion, and the two missing blocks merge into [11, 13].
  const { outputs, errors: e2 } = run(engine, [retract('p1', 12, 2, T0 + 3000)]);
  assert.equal(e2.length, 0);
  assert.deepEqual(outputs[0], { type: 'RETRACT_OK', profileId: 'p1', depth: 12, version: 2 });

  cert = profile.certificate();
  assert.deepEqual(cert.depths, [10, 14]);
  assert.deepEqual(cert.inversions, []);
  assert.equal(cert.maxInversion, null);
  assert.deepEqual(cert.missing.blocks, [[11, 13]]);
  assert.equal(cert.missing.blockCount, 1);
  assert.equal(cert.missing.missingCount, 3);

  // A stale re-upsert of the retracted point is rejected (version 2 is known).
  const { errors: e3 } = run(engine, [upsert('p1', 12, 99, 1, T0 + 4000)]);
  assert.equal(e3.length, 1);
  assert.equal(e3[0].code, 'STALE_VERSION');
});

test('acceptance: corrections after watermark close are rejected as LATE', () => {
  const engine = new Engine();
  const { outputs, errors: e1 } = run(engine, [
    upsert('p1', 50, 18, 1, T0),
    upsert('p1', 60, 19, 1, T0 + 60 * 1000),
    watermark(T0 + 60 * 1000 + HALF_HOUR + 1),
  ]);
  assert.equal(e1.length, 0);
  assert.equal(outputs.filter((o) => o.type === 'CERTIFICATE').length, 1);

  const upsertLate = engine.apply(upsert('p1', 70, 20, 1, T0 + 2 * HALF_HOUR));
  assert.equal(upsertLate.errors.length, 1);
  assert.equal(upsertLate.errors[0].code, 'LATE');
  assert.equal(upsertLate.outputs.length, 0);

  const retractLate = engine.apply(retract('p1', 50, 2, T0 + 2 * HALF_HOUR));
  assert.equal(retractLate.errors.length, 1);
  assert.equal(retractLate.errors[0].code, 'LATE');
});

test('watermark closes profile only strictly after 30 minutes of silence', () => {
  const engine = new Engine();
  run(engine, [upsert('p1', 10, 20, 1, T0)]);

  // Exactly 30 minutes later: not yet closed.
  let result = engine.apply(watermark(T0 + HALF_HOUR));
  assert.equal(result.outputs.length, 0);
  assert.equal(engine.profiles.get('p1').closed, false);

  // One millisecond past the gap: closed and certificate emitted.
  result = engine.apply(watermark(T0 + HALF_HOUR + 1));
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].type, 'CERTIFICATE');
  assert.equal(engine.profiles.get('p1').closed, true);

  // A later watermark does not republish.
  result = engine.apply(watermark(T0 + 2 * HALF_HOUR));
  assert.equal(result.outputs.length, 0);
});

test('out-of-order event times: last observation time is the max seen', () => {
  const engine = new Engine();
  run(engine, [
    upsert('p1', 10, 20, 1, T0 + 10 * 60 * 1000), // arrives first, later timestamp
    upsert('p1', 20, 19, 1, T0), // arrives second, earlier timestamp
  ]);
  // Watermark 31 min after T0 must NOT close: last observation is T0+10min.
  let result = engine.apply(watermark(T0 + HALF_HOUR + 1));
  assert.equal(result.outputs.length, 0);
  result = engine.apply(watermark(T0 + 10 * 60 * 1000 + HALF_HOUR + 1));
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].type, 'CERTIFICATE');
});

test('version conflicts and unknown retracts are rejected', () => {
  const engine = new Engine();
  run(engine, [upsert('p1', 100, 15, 3, T0)]);

  let result = engine.apply(upsert('p1', 100, 16, 2, T0 + 1000));
  assert.equal(result.errors[0].code, 'STALE_VERSION');
  result = engine.apply(upsert('p1', 100, 16, 3, T0 + 1000));
  assert.equal(result.errors[0].code, 'STALE_VERSION');

  result = engine.apply(retract('p1', 100, 2, T0 + 2000));
  assert.equal(result.errors[0].code, 'STALE_VERSION');

  result = engine.apply(retract('p1', 200, 1, T0 + 2000));
  assert.equal(result.errors[0].code, 'UNKNOWN_RETRACT');

  result = engine.apply(retract('p2', 100, 1, T0 + 2000));
  assert.equal(result.errors[0].code, 'UNKNOWN_RETRACT');

  // Higher version wins and overwrites the temperature.
  result = engine.apply(upsert('p1', 100, 22, 4, T0 + 3000));
  assert.deepEqual(result.outputs[0], {
    type: 'UPSERT_OK',
    profileId: 'p1',
    depth: 100,
    version: 4,
  });
  assert.equal(engine.profiles.get('p1').points.get(100).temp, 22);
});

test('invalid depths and malformed events are rejected', () => {
  const engine = new Engine();
  for (const depth of [-1, 1001, 10.5, '50', NaN]) {
    const result = engine.apply(upsert('p1', depth, 10, 1, T0));
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, 'INVALID_DEPTH');
  }
  let result = engine.apply({ type: 'UPSERT', profileId: 'p1', depth: 10, version: 1, time: T0 });
  assert.equal(result.errors[0].code, 'INVALID_EVENT'); // missing temp
  result = engine.apply({ type: 'BOGUS', profileId: 'p1' });
  assert.equal(result.errors[0].code, 'UNKNOWN_TYPE');
  result = engine.apply({ type: 'WATERMARK', time: 'not-a-time' });
  assert.equal(result.errors[0].code, 'INVALID_EVENT');
});

test('inversion threshold: rise of exactly 0.5C is not an inversion', () => {
  const engine = new Engine();
  const { outputs, errors } = run(engine, [
    upsert('p1', 10, 20.0, 1, T0),
    upsert('p1', 20, 20.5, 1, T0 + 1000),
    upsert('p1', 30, 21.01, 1, T0 + 2000),
    watermark(T0 + 2000 + HALF_HOUR + 1),
  ]);
  assert.equal(errors.length, 0);
  const cert = outputs.find((o) => o.type === 'CERTIFICATE');
  assert.deepEqual(cert.inversions, [[20, 30]]);
  assert.deepEqual(cert.maxInversion, { top: 20, bottom: 30, span: 10 });
});

test('temp update on existing depth recomputes adjacent pairs only', () => {
  const engine = new Engine();
  run(engine, [
    upsert('p1', 10, 20, 1, T0),
    upsert('p1', 20, 21, 1, T0 + 1000), // inversion (10,20)
    upsert('p1', 30, 22, 1, T0 + 2000), // inversion (20,30)
  ]);
  let cert = engine.profiles.get('p1').certificate();
  assert.deepEqual(cert.maxInversion, { top: 10, bottom: 30, span: 20 });

  // Cooling the middle point breaks pair (10,20) but deepens pair (20,30):
  // both adjacent pairs are recomputed incrementally.
  run(engine, [upsert('p1', 20, 19, 2, T0 + 3000)]);
  cert = engine.profiles.get('p1').certificate();
  assert.deepEqual(cert.inversions, [[20, 30]]);
  assert.deepEqual(cert.maxInversion, { top: 20, bottom: 30, span: 10 });

  // Heating the middle point above the deepest temp kills the layer entirely.
  run(engine, [upsert('p1', 20, 25, 3, T0 + 4000)]);
  cert = engine.profiles.get('p1').certificate();
  assert.deepEqual(cert.inversions, [[10, 20]]);
  assert.deepEqual(cert.maxInversion, { top: 10, bottom: 20, span: 10 });
});

test('property: random op sequences match brute-force reference', () => {
  let seed = 0xC0FFEE;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 200; trial++) {
    const engine = new Engine();
    const live = new Map(); // depth -> { temp, version }
    const versions = new Map(); // depth -> highest version ever used
    const pointCount = 1 + Math.floor(rand() * 20); // <= 20 points
    const depths = [];
    while (depths.length < pointCount) {
      const d = Math.floor(rand() * 1001);
      if (!depths.includes(d)) depths.push(d);
    }

    let clock = T0;
    const bump = () => {
      clock += Math.floor(rand() * 60 * 1000);
      return clock;
    };

    for (const depth of depths) {
      const temp = -2 + rand() * 35;
      const version = 1;
      const { errors } = run(engine, [upsert('p', depth, temp, version, bump())]);
      assert.equal(errors.length, 0);
      live.set(depth, { temp, version });
      versions.set(depth, version);
    }

    // Random follow-up ops: updates, retracts, stale attempts.
    const opCount = Math.floor(rand() * 30);
    for (let op = 0; op < opCount; op++) {
      const depth = depths[Math.floor(rand() * depths.length)];
      const roll = rand();
      const nextVersion = (versions.get(depth) || 0) + 1;
      if (roll < 0.45) {
        const temp = -2 + rand() * 35;
        const { errors } = run(engine, [upsert('p', depth, temp, nextVersion, bump())]);
        assert.equal(errors.length, 0);
        live.set(depth, { temp, version: nextVersion });
        versions.set(depth, nextVersion);
      } else if (roll < 0.7 && live.has(depth)) {
        const { errors } = run(engine, [retract('p', depth, nextVersion, bump())]);
        assert.equal(errors.length, 0);
        live.delete(depth);
        versions.set(depth, nextVersion);
      } else if (roll < 0.85) {
        // stale upsert with an old version
        const known = versions.get(depth);
        if (known === undefined) continue;
        const { errors } = run(engine, [upsert('p', depth, 0, known, bump())]);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 'STALE_VERSION');
      }
      // else: no-op
    }

    const points = [...live.entries()].map(([depth, v]) => ({ depth, temp: v.temp }));
    assert.ok(points.length <= 20);

    const { outputs, errors } = run(engine, [watermark(clock + HALF_HOUR + 1)]);
    assert.equal(errors.length, 0);
    const cert = outputs.find((o) => o.type === 'CERTIFICATE');
    assert.ok(cert, `trial ${trial}: certificate emitted`);
    assert.deepEqual(
      cert.depths,
      points.map((p) => p.depth).sort((a, b) => a - b)
    );
    assert.deepEqual(cert.inversions, referenceInversions(points), `trial ${trial}`);
    assert.deepEqual(cert.maxInversion, referenceMaxInversion(points), `trial ${trial}`);
    assert.deepEqual(cert.missing, referenceMissing(points), `trial ${trial}`);
  }
});
