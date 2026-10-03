import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { referenceAlarms } from '../src/reference.js';

function runAll(engine, cmds) {
  const out = [];
  for (const cmd of cmds) out.push(...engine.execute(cmd));
  return out;
}

function alarmsFor(out, rule) {
  const rec = out.find((r) => r.type === 'alarms' && r.rule === rule);
  assert.ok(rec, `expected alarms record for rule ${rule}`);
  return rec;
}

test('acceptance 1: three periods crossing a shift offset switch', () => {
  const setup = (heartbeats) => {
    const engine = new Engine();
    return runAll(engine, [
      { cmd: 'shiftTable', id: 'st1', offsets: [
        { start: 0, end: 100, offset: 0 },
        { start: 100, end: 200, offset: 10 },
      ] },
      { cmd: 'rule', id: 'r1', device: 'd1', periodStart: 0, periodLength: 50,
        expectedOffset: 5, grace: 10, shiftTable: 'st1' },
      ...heartbeats,
      { cmd: 'cutoff', time: 130 },
      { cmd: 'scan' },
    ]);
  };

  // Periods: k0 window [5,15] (offset 0), k1 window [55,65] (offset 0),
  // k2 window [115,125] (offset 10 after the shift switch at t=100).
  // Heartbeat at 120 only counts because the offset switch moved the window.
  const out = setup([
    { cmd: 'heartbeat', id: 'h1', device: 'd1', time: 6 },
    { cmd: 'heartbeat', id: 'h2', device: 'd1', time: 60 },
    { cmd: 'heartbeat', id: 'h3', device: 'd1', time: 120 },
  ]);
  const rec = alarmsFor(out, 'r1');
  assert.deepEqual(rec.alarms, []);
  assert.equal(rec.certificate.periodCount, 3);
  assert.equal(rec.certificate.from, 0);
  assert.equal(rec.certificate.to, 130);
  assert.match(rec.certificate.boundariesHash, /^[0-9a-f]{64}$/);

  // Same three periods, but the third one stays silent -> OPEN alarm whose
  // start proves the offset switch was applied (115, not 105).
  const outSilent = setup([
    { cmd: 'heartbeat', id: 'h1', device: 'd1', time: 6 },
    { cmd: 'heartbeat', id: 'h2', device: 'd1', time: 60 },
  ]);
  assert.deepEqual(alarmsFor(outSilent, 'r1').alarms, [
    { start: 115, end: 130, status: 'OPEN', missedPeriods: [2] },
  ]);

  // A heartbeat at 112 would hit the un-shifted window [105,115]; after the
  // offset switch it must NOT count for k2.
  const outWrongSide = setup([
    { cmd: 'heartbeat', id: 'h1', device: 'd1', time: 6 },
    { cmd: 'heartbeat', id: 'h2', device: 'd1', time: 60 },
    { cmd: 'heartbeat', id: 'h3', device: 'd1', time: 112 },
  ]);
  assert.deepEqual(alarmsFor(outWrongSide, 'r1').alarms, [
    { start: 115, end: 130, status: 'OPEN', missedPeriods: [2] },
  ]);
});

test('acceptance 2: retracted heartbeat creates an alarm that merges with the next one', () => {
  const engine = new Engine();
  const beats = [0, 10, 20, 30, 60, 70, 80, 90].map((t) => ({
    cmd: 'heartbeat', id: `h${t}`, device: 'd2', time: t,
  }));
  const out = runAll(engine, [
    { cmd: 'rule', id: 'r2', device: 'd2', periodStart: 0, periodLength: 10,
      expectedOffset: 0, grace: 2, mergeGap: 20 },
    ...beats,
    { cmd: 'cutoff', time: 100 },
    { cmd: 'scan' },
  ]);
  // Periods 4 and 5 are silent -> one CLOSED alarm [40,52].
  assert.deepEqual(alarmsFor(out, 'r2').alarms, [
    { start: 40, end: 52, status: 'CLOSED', missedPeriods: [4, 5] },
  ]);

  // Retract the heartbeat at 70: period 7 becomes missed, producing a second
  // alarm [70,72]; gap 70-52=18 <= mergeGap 20, so the two alarms merge.
  const corr = runAll(engine, [{ cmd: 'retract', id: 'h70' }]);
  const c = corr.find((r) => r.type === 'correction');
  assert.ok(c, 'expected a correction record');
  assert.equal(c.kind, 'retract');
  assert.equal(c.event, 'h70');
  assert.equal(c.affected.length, 1);
  assert.equal(c.affected[0].rule, 'r2');
  assert.equal(c.affected[0].version, 2);
  assert.equal(c.affected[0].certificate.periodCount, 10);
  assert.match(c.affected[0].certificate.boundariesHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(c.affected[0].alarms, [
    { start: 40, end: 72, status: 'CLOSED', missedPeriods: [4, 5, 7] },
  ]);

  // Override correction: move heartbeat h90 out of period 9's window [90,92].
  // The tail run reaches the cutoff -> OPEN, and merges into the same alarm.
  const corr2 = runAll(engine, [{ cmd: 'override', id: 'h90', time: 95 }]);
  const c2 = corr2.find((r) => r.type === 'correction');
  assert.equal(c2.kind, 'override');
  assert.equal(c2.affected[0].version, 3);
  assert.deepEqual(c2.affected[0].alarms, [
    { start: 40, end: 100, status: 'OPEN', missedPeriods: [4, 5, 7, 9] },
  ]);
});

test('acceptance 3: downtime boundary and OPEN interval, cross-checked with reference', () => {
  const engine = new Engine();
  const out = runAll(engine, [
    { cmd: 'rule', id: 'r3', device: 'd3', periodStart: 0, periodLength: 10,
      expectedOffset: 0, grace: 5, mergeGap: 0 },
    { cmd: 'downtime', device: 'd3', start: 24, end: 44 },
    { cmd: 'heartbeat', id: 'b1', device: 'd3', time: 1 },
    { cmd: 'heartbeat', id: 'b2', device: 'd3', time: 12 },
    { cmd: 'heartbeat', id: 'b3', device: 'd3', time: 22 },
    { cmd: 'heartbeat', id: 'b4', device: 'd3', time: 44.5 },
    { cmd: 'heartbeat', id: 'b5', device: 'd3', time: 61 },
    { cmd: 'heartbeat', id: 'b6', device: 'd3', time: 70 },
    { cmd: 'cutoff', time: 100 },
    { cmd: 'scan' },
  ]);
  // k2 [20,25] is cut by downtime [24,44]; heartbeat at 22 (before the
  // boundary) counts. k3 [30,35] is fully inside downtime -> exempt.
  // k4 [40,45] needs a heartbeat after the boundary: 44.5 counts.
  // k5 [50,55] silent -> CLOSED alarm; k8,k9 silent -> OPEN alarm to cutoff.
  const expected = [
    { start: 50, end: 55, status: 'CLOSED', missedPeriods: [5] },
    { start: 80, end: 100, status: 'OPEN', missedPeriods: [8, 9] },
  ];
  const rec = alarmsFor(out, 'r3');
  assert.deepEqual(rec.alarms, expected);

  // Cross-check against the reference algorithm (per-period heartbeat sets).
  const rule = { periodStart: 0, periodLength: 10, expectedOffset: 0, grace: 5, mergeGap: 0 };
  const ref = referenceAlarms(rule, null, [1, 12, 22, 44.5, 61, 70],
    [{ start: 24, end: 44 }], 100);
  assert.deepEqual(rec.alarms, ref);

  // Boundary separation: without the 44.5 heartbeat, period k4 must be missed
  // -- the heartbeat at 22 (before the downtime) must not leak across.
  const engine2 = new Engine();
  const out2 = runAll(engine2, [
    { cmd: 'rule', id: 'r3', device: 'd3', periodStart: 0, periodLength: 10,
      expectedOffset: 0, grace: 5, mergeGap: 0 },
    { cmd: 'downtime', device: 'd3', start: 24, end: 44 },
    { cmd: 'heartbeat', id: 'b1', device: 'd3', time: 1 },
    { cmd: 'heartbeat', id: 'b2', device: 'd3', time: 12 },
    { cmd: 'heartbeat', id: 'b3', device: 'd3', time: 22 },
    { cmd: 'heartbeat', id: 'b5', device: 'd3', time: 61 },
    { cmd: 'heartbeat', id: 'b6', device: 'd3', time: 70 },
    { cmd: 'cutoff', time: 100 },
    { cmd: 'scan' },
  ]);
  const expected2 = [
    { start: 40, end: 55, status: 'CLOSED', missedPeriods: [4, 5] },
    { start: 80, end: 100, status: 'OPEN', missedPeriods: [8, 9] },
  ];
  assert.deepEqual(alarmsFor(out2, 'r3').alarms, expected2);
  const ref2 = referenceAlarms(rule, null, [1, 12, 22, 61, 70],
    [{ start: 24, end: 44 }], 100);
  assert.deepEqual(alarmsFor(out2, 'r3').alarms, ref2);
});

test('reference cross-check: randomized fuzz over rules, heartbeats, downtimes, shift tables', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let iter = 0; iter < 300; iter++) {
    const periodLength = 1 + Math.floor(rand() * 15);
    const expectedOffset = Math.floor(rand() * periodLength);
    const grace = Math.floor(rand() * (periodLength + 1));
    const mergeGap = Math.floor(rand() * 30);
    const cutoff = 20 + Math.floor(rand() * 180);

    let table = null;
    if (rand() < 0.5) {
      table = [];
      let t = 0;
      while (t < 500) {
        const dur = 10 + Math.floor(rand() * 50);
        table.push({ start: t, end: t + dur, offset: Math.floor(rand() * 11) - 3 });
        t += dur;
      }
    }

    const beatSet = new Set();
    const nBeats = Math.floor(rand() * 25);
    while (beatSet.size < nBeats) beatSet.add(Math.floor(rand() * (cutoff + 10)));
    const beats = [...beatSet].sort((a, b) => a - b);

    const downtimes = [];
    const nDown = Math.floor(rand() * 3);
    for (let i = 0; i < nDown; i++) {
      const s = Math.floor(rand() * cutoff);
      const e = s + 1 + Math.floor(rand() * 20);
      downtimes.push({ start: s, end: e });
    }

    const engine = new Engine();
    const cmds = [];
    if (table) cmds.push({ cmd: 'shiftTable', id: 'st', offsets: table });
    cmds.push({
      cmd: 'rule', id: 'r', device: 'd', periodStart: 0, periodLength,
      expectedOffset, grace, mergeGap, ...(table ? { shiftTable: 'st' } : {}),
    });
    beats.forEach((t, i) => cmds.push({ cmd: 'heartbeat', id: `h${i}`, device: 'd', time: t }));
    for (const dt of downtimes) cmds.push({ cmd: 'downtime', device: 'd', start: dt.start, end: dt.end });
    cmds.push({ cmd: 'cutoff', time: cutoff }, { cmd: 'scan' });
    const out = runAll(engine, cmds);
    const errors = out.filter((r) => r.type === 'error');
    assert.deepEqual(errors, [], `iteration ${iter}: unexpected errors`);

    const rule = { periodStart: 0, periodLength, expectedOffset, grace, mergeGap };
    const ref = referenceAlarms(rule, table, beats, downtimes, cutoff);
    assert.deepEqual(alarmsFor(out, 'r').alarms, ref, `iteration ${iter} mismatch`);
  }
});
