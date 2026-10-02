'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Engine } = require('../src/engine');
const { referenceAlarms } = require('../src/reference');

function runCli(inputText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-alarm-'));
  const inputFile = path.join(dir, 'in.ndjson');
  const outputFile = path.join(dir, 'out.ndjson');
  fs.writeFileSync(inputFile, inputText);
  const res = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'bin', 'cli.js'), inputFile, outputFile],
    { encoding: 'utf8' },
  );
  const stdout = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, lines: stdout.trim() === '' ? [] : stdout.trim().split('\n').map((l) => JSON.parse(l)) };
}

function makeEngine({ shifts, downtime = [], mergeGapMs = 0, rules }) {
  const engine = new Engine();
  engine.setShiftTable(shifts);
  engine.setDowntime(downtime);
  engine.setMergeGap(mergeGapMs);
  for (const rule of rules) engine.addRule(rule);
  return engine;
}

function appendHeartbeats(engine, times) {
  times.forEach((t, i) => engine.applyEvent({ id: `hb${i}`, kind: 'append', time: t }));
}

function referenceFor(engine, rules, shifts, downtime, cutoffMs, mergeGapMs) {
  return referenceAlarms({
    rules,
    shiftTable: shifts,
    downtime,
    heartbeats: [...engine.heartbeats.values()],
    cutoffMs,
    mergeGapMs,
  });
}

test('acceptance 1: three periods across a shift offset switch', () => {
  const shifts = [
    { start: 0, end: 2500, offsetMs: 0 },
    { start: 2500, end: 100000, offsetMs: 300 },
  ];
  const rules = [{ id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100], graceMs: 50 }];
  const engine = makeEngine({ shifts, rules });

  // Period starts: k0=0, k1=1000, k2=2000 (offset 0), then the shift table
  // switches at t=2500 so k3=3300, k4=4300, k5=5300 (offset +300).
  appendHeartbeats(engine, [100, 1100, 2100, 3100, 4400]);
  engine.setCutoff(5000);

  assert.deepEqual(engine.periodBoundaries('r1'), [0, 1000, 2000, 3300, 4300, 5300, 6300]);

  // Heartbeat at 3100 lands where the *unshifted* period k3 would expect it;
  // after the offset switch k3 expects 3400, so k3 is silent. k4 is covered
  // by the heartbeat at 4400. Exactly one closed alarm across the switch.
  const alarms = engine.alarms();
  assert.deepEqual(alarms, [
    { ruleId: 'r1', fromPeriod: 3, toPeriod: 3, start: 3300, end: 4300, status: 'CLOSED' },
  ]);

  assert.deepEqual(engine.alarms(), referenceFor(engine, rules, shifts, [], 5000, 0));
});

test('acceptance 2: retracted heartbeat raises an alarm that merges with the next one', () => {
  const shifts = [{ start: 0, end: 100000, offsetMs: 0 }];
  const rules = [{ id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100], graceMs: 50 }];
  const engine = makeEngine({ shifts, rules, mergeGapMs: 1500 });

  appendHeartbeats(engine, [100, 1100, 2100, 3100, 4100]);
  engine.setCutoff(5000);
  assert.deepEqual(engine.alarms(), []);

  const c1 = engine.applyEvent({ id: 'hb2', kind: 'retract', at: 6000 });
  assert.equal(c1.length, 1);
  assert.equal(c1[0].type, 'correction');
  assert.equal(c1[0].ruleId, 'r1');
  assert.equal(c1[0].version, 6); // 5 appends + this retract
  assert.deepEqual(c1[0].certificate.boundaries, [0, 1000, 2000, 3000, 4000, 5000, 6000]);
  assert.equal(c1[0].certificate.cutoffMs, 5000);
  assert.match(c1[0].certificate.digest, /^[0-9a-f]{64}$/);

  // Period k2 (2000-3000) is now silent.
  assert.deepEqual(engine.alarms(), [
    { ruleId: 'r1', fromPeriod: 2, toPeriod: 2, start: 2000, end: 3000, status: 'CLOSED' },
  ]);

  // Retract the k4 heartbeat too: two alarms 1000ms apart, within mergeGapMs.
  const c2 = engine.applyEvent({ id: 'hb4', kind: 'retract', at: 6001 });
  assert.equal(c2[0].version, 7);
  assert.deepEqual(engine.alarms(), [
    { ruleId: 'r1', fromPeriod: 2, toPeriod: 4, start: 2000, end: 5000, status: 'CLOSED' },
  ]);

  // The merge gap is configurable: shrinking it splits the alarms again.
  engine.setMergeGap(500);
  assert.deepEqual(engine.alarms(), [
    { ruleId: 'r1', fromPeriod: 2, toPeriod: 2, start: 2000, end: 3000, status: 'CLOSED' },
    { ruleId: 'r1', fromPeriod: 4, toPeriod: 4, start: 4000, end: 5000, status: 'CLOSED' },
  ]);
});

test('acceptance 3: downtime boundary and OPEN interval, cross-checked with reference', () => {
  const shifts = [{ start: 0, end: 100000, offsetMs: 0 }];
  const downtime = [{ start: 1120, end: 1650 }];
  const rules = [{ id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100, 600], graceMs: 50 }];
  const engine = makeEngine({ shifts, rules, downtime });

  // hb3 at 1110 covers expectation 1100 of period k1 (its grace window
  // [1100,1150] crosses the downtime boundary at 1120). hb4 at 1130 is inside
  // downtime and must NOT count for expectations outside it.
  appendHeartbeats(engine, [100, 600, 1110, 1130]);
  engine.setCutoff(3120);

  // k0 ok; k1 ok (1100 covered by 1110, 1600 exempt inside downtime);
  // k2 silent (2100/2600 missing, grace expired); k3 pending (3100 missing but
  // grace window [3100,3150] not closed at cutoff 3120) -> OPEN alarm.
  const expected = [
    { ruleId: 'r1', fromPeriod: 2, toPeriod: 3, start: 2000, end: null, status: 'OPEN' },
  ];
  assert.deepEqual(engine.alarms(), expected);
  assert.deepEqual(engine.alarms(), referenceFor(engine, rules, shifts, downtime, 3120, 0));

  // Retract the boundary heartbeat: k1 becomes silent and the alarm extends
  // back across the downtime boundary.
  engine.applyEvent({ id: 'hb2', kind: 'retract', at: 4000 });
  const expected2 = [
    { ruleId: 'r1', fromPeriod: 1, toPeriod: 3, start: 1000, end: null, status: 'OPEN' },
  ];
  assert.deepEqual(engine.alarms(), expected2);
  assert.deepEqual(engine.alarms(), referenceFor(engine, rules, shifts, downtime, 3120, 0));
});

test('override correction moves a heartbeat and bumps the rule version', () => {
  const shifts = [{ start: 0, end: 100000, offsetMs: 0 }];
  const rules = [{ id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100], graceMs: 50 }];
  const engine = makeEngine({ shifts, rules });

  appendHeartbeats(engine, [100, 1100, 2100]);
  engine.setCutoff(2500);
  assert.deepEqual(engine.alarms(), []);

  // Move the k0 heartbeat into period k2's duplicate slot: k0 goes silent.
  const corrections = engine.applyEvent({ id: 'hb0', kind: 'override', time: 2150, at: 3000 });
  assert.equal(corrections[0].version, 4);
  assert.equal(corrections[0].certificate.eventId, 'hb0');
  assert.deepEqual(engine.alarms(), [
    { ruleId: 'r1', fromPeriod: 0, toPeriod: 0, start: 0, end: 1000, status: 'CLOSED' },
  ]);
});

test('error: zero period is rejected', () => {
  const engine = new Engine();
  engine.setShiftTable([{ start: 0, end: 1000, offsetMs: 0 }]);
  assert.throws(
    () => engine.addRule({ id: 'bad', epochStartMs: 0, periodMs: 0, expectedOffsetsMs: [0], graceMs: 0 }),
    (err) => err.code === 'PERIOD_ZERO',
  );
});

test('error: offset table gap is reported when a period boundary lands in it', () => {
  const engine = new Engine();
  engine.setShiftTable([
    { start: 0, end: 1000, offsetMs: 0 },
    { start: 2000, end: 100000, offsetMs: 0 },
  ]);
  engine.addRule({ id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100], graceMs: 50 });
  engine.setCutoff(1500);
  assert.throws(() => engine.alarms(), (err) => err.code === 'OFFSET_GAP');
});

test('error: event time inversion is rejected', () => {
  const engine = new Engine();
  engine.setShiftTable([{ start: 0, end: 100000, offsetMs: 0 }]);
  engine.addRule({ id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100], graceMs: 50 });
  engine.applyEvent({ id: 'a', kind: 'append', time: 100 });
  assert.throws(
    () => engine.applyEvent({ id: 'b', kind: 'append', time: 50 }),
    (err) => err.code === 'TIME_INVERSION',
  );
});

test('randomized cross-check: engine matches the per-period reference', () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  for (let scenario = 0; scenario < 100; scenario++) {
    const periodMs = randInt(2, 20) * 50;
    const segCount = randInt(1, 3);
    const shifts = [];
    let cursor = 0;
    for (let s = 0; s < segCount; s++) {
      const end = s === segCount - 1 ? 20000 : cursor + randInt(10, 80) * 50;
      shifts.push({ start: cursor, end, offsetMs: randInt(0, 10) * 50 });
      cursor = end;
    }
    const downtime = [];
    for (let d = 0, n = randInt(0, 3); d < n; d++) {
      const start = randInt(0, 180) * 100;
      downtime.push({ start, end: start + randInt(1, 12) * 50 });
    }
    const expectedCount = randInt(1, 3);
    const expectedOffsetsMs = [];
    for (let e = 0; e < expectedCount; e++) expectedOffsetsMs.push(randInt(0, periodMs - 1));
    const graceMs = randInt(0, 4) * 50;
    const mergeGapMs = [0, 50, 200, 1000][randInt(0, 3)];
    const cutoffMs = randInt(20, 200) * 100;
    const hbTimes = [];
    for (let h = 0, n = randInt(0, 40); h < n; h++) hbTimes.push(randInt(0, 190) * 100);
    hbTimes.sort((a, b) => a - b);

    const rules = [{ id: 'r1', epochStartMs: 0, periodMs, expectedOffsetsMs, graceMs }];
    const engine = makeEngine({ shifts, rules, downtime, mergeGapMs });
    appendHeartbeats(engine, hbTimes);
    engine.setCutoff(cutoffMs);

    assert.deepEqual(
      engine.alarms(),
      referenceFor(engine, rules, shifts, downtime, cutoffMs, mergeGapMs),
      `scenario ${scenario} mismatch`,
    );
  }
});

test('cli: ndjson commands in, json lines out', () => {
  const input = [
    JSON.stringify({ cmd: 'shifts', table: [{ start: 0, end: 100000, offsetMs: 0 }] }),
    JSON.stringify({ cmd: 'rule', id: 'r1', epochStartMs: 0, periodMs: 1000, expectedOffsetsMs: [100], graceMs: 50 }),
    JSON.stringify({ cmd: 'event', id: 'h1', kind: 'append', time: 100 }),
    JSON.stringify({ cmd: 'cutoff', time: 2500 }),
    JSON.stringify({ cmd: 'alarms' }),
    '',
  ].join('\n');
  const res = runCli(input);
  assert.equal(res.status, 0);
  const lines = res.lines;
  assert.deepEqual(lines.map((l) => l.type), ['ok', 'ok', 'correction', 'alarms', 'alarms']);
  assert.equal(lines[2].ruleId, 'r1');
  assert.equal(lines[2].version, 1);
  const expectedAlarms = [
    { ruleId: 'r1', fromPeriod: 1, toPeriod: 2, start: 1000, end: null, status: 'OPEN' },
  ];
  assert.deepEqual(lines[3].alarms, expectedAlarms);
  assert.deepEqual(lines[4].alarms, expectedAlarms);
});

test('cli: invalid command produces an error line and exit code 1', () => {
  const input = JSON.stringify({
    cmd: 'rule', id: 'bad', epochStartMs: 0, periodMs: 0, expectedOffsetsMs: [0], graceMs: 0,
  }) + '\n';
  const res = runCli(input);
  assert.equal(res.status, 1);
  const lines = res.lines;
  assert.equal(lines[0].type, 'error');
  assert.equal(lines[0].code, 'PERIOD_ZERO');
});
