import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const T0 = 1_700_000_000_000;
const MIN = 60000;

function makeEngine() {
  const engine = new Engine();
  engine.handle({ type: 'defineZone', zone: 'PLANT_A', rules: [{ atUtc: T0, offsetMinutes: 480 }] });
  return engine;
}
const localAt = (utcMs) => {
  // PLANT_A is UTC+8: local = utc + 8h
  const ms = utcMs + 480 * MIN;
  return isoFromMs(ms);
};
function isoFromMs(ms) {
  // minimal UTC ISO formatter for test data construction
  const days = Math.floor(ms / 86400000);
  let rem = ms - days * 86400000;
  const h = Math.floor(rem / 3600000); rem -= h * 3600000;
  const m = Math.floor(rem / 60000); rem -= m * 60000;
  const s = Math.floor(rem / 1000);
  const f = rem - s * 1000;
  const base = new Date(Date.UTC(1970, 0, 1 + days));
  const p = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return `${base.getUTCFullYear()}-${p(base.getUTCMonth() + 1)}-${p(base.getUTCDate())}T${p(h)}:${p(m)}:${p(s)}.${p3(f)}`;
}

// Acceptance 2: a late correction changes the merging of three periods.
test('late void correction merges three periods into one interval', () => {
  const engine = makeEngine();
  const P = T0 + 86400000; // period grid origin
  const ev = (id, state, utcMs, version) =>
    engine.handle({ type: 'event', id, device: 'd1', zone: 'PLANT_A', state, local: localAt(utcMs), version });

  ev('e1', 'ON', P + 100, 1);
  ev('e2', 'OFF', P + 1100, 2);
  ev('e3', 'ON', P + 2100, 3);

  const observe = {
    device: 'd1', from: P, to: P + 3000,
    period: { start: P, durationMs: 1000, end: P + 3000 },
    silence: [{ start: P, end: P + 3000 }],
  };

  const before = engine.handle({ type: 'query', ...observe });
  assert.deepEqual(before.intervals.map(i => [i.state, i.start - P, i.end - P, i.status]), [
    ['ON', 100, 1100, 'CLOSED'],   // periods 0+1 merged via silence
    ['OFF', 1100, 2100, 'CLOSED'], // periods 1+2 merged via silence
    ['ON', 2100, 3000, 'UNCLOSED'],
  ]);

  // Late correction: the OFF event was wrong -> void it at version 4.
  const corr = engine.handle({ type: 'correct', id: 'e2', action: 'void', version: 4, observe });
  assert.equal(corr.ok, true);
  assert.equal(corr.type, 'correctionResult');

  // The three periods now collapse into a single UNCLOSED ON interval.
  assert.deepEqual(corr.certificate.after.map(i => [i.state, i.start - P, i.end - P, i.status]), [
    ['ON', 100, 3000, 'UNCLOSED'],
  ]);
  assert.equal(corr.certificate.before.length, 3);
  assert.equal(corr.certificate.after.length, 1);

  // Affected interval and timeline.
  assert.deepEqual(corr.affected, { from: P + 1100, to: P + 2100 });
  assert.deepEqual(corr.certificate.timeline, [
    { from: P + 1100, to: P + 2100, before: 'OFF', after: 'ON' },
  ]);

  // Certificate lists the original ids of the merged events.
  assert.deepEqual([...corr.certificate.mergedEventIds].sort(), ['e1', 'e3']);
  assert.deepEqual(corr.certificate.after[0].ids, ['e1', 'e3']);
  assert.deepEqual(corr.certificate.after[0].mergedIds, []);

  // Replay by version: as of v3 the OFF still stands; as of v4 it is gone.
  const replay3 = engine.handle({ type: 'replay', toVersion: 3, observe });
  assert.equal(replay3.intervals.length, 3);
  const replay4 = engine.handle({ type: 'replay', toVersion: 4, observe });
  assert.equal(replay4.intervals.length, 1);
  assert.equal(replay4.intervals[0].status, 'UNCLOSED');
});

test('replace correction shifts an interval boundary and reports the delta', () => {
  const engine = makeEngine();
  const P = T0 + 2 * 86400000;
  const ev = (id, state, utcMs, version) =>
    engine.handle({ type: 'event', id, device: 'd2', zone: 'PLANT_A', state, local: localAt(utcMs), version });
  ev('a', 'ON', P + 1000, 1);
  ev('b', 'OFF', P + 2000, 2);

  const observe = { device: 'd2', from: P, to: P + 5000 };
  const corr = engine.handle({
    type: 'correct', id: 'b', action: 'replace', version: 3,
    event: { device: 'd2', zone: 'PLANT_A', state: 'OFF', local: localAt(P + 4000) },
    observe,
  });
  assert.equal(corr.ok, true);
  assert.deepEqual(corr.affected, { from: P + 2000, to: P + 4000 });
  assert.deepEqual(corr.certificate.timeline, [
    { from: P + 2000, to: P + 4000, before: 'OFF', after: 'ON' },
  ]);
  assert.deepEqual(corr.certificate.after.map(i => [i.state, i.start - P, i.end - P, i.status]), [
    ['ON', 1000, 4000, 'CLOSED'],
    ['OFF', 4000, 5000, 'UNCLOSED'],
  ]);
});

test('pending events are not unsatisfiable: trailing event stays UNCLOSED', () => {
  const engine = makeEngine();
  const P = T0 + 3 * 86400000;
  engine.handle({ type: 'event', id: 'only', device: 'd3', zone: 'PLANT_A', state: 'ON', local: localAt(P + 50), version: 1 });
  const q = engine.handle({ type: 'query', device: 'd3', from: P, to: P + 100 });
  assert.equal(q.intervals.length, 1);
  assert.equal(q.intervals[0].status, 'UNCLOSED');
  assert.equal(q.intervals[0].end, P + 100, 'open interval extends to observation cutoff');
});
