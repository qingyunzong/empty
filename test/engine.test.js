import test from 'node:test';
import assert from 'node:assert/strict';
import { run, wearOf, RATED_FORCE } from '../src/engine.js';

const change = (eventTs, tool, newLife, op) => ({ type: 'change', eventTs, tool, newLife, op });
const load = (eventTs, tool, part, force, seconds, op) => ({ type: 'load', eventTs, tool, part, force, seconds, op });
const qc = (eventTs, part, ok, op) => ({ type: 'qc', eventTs, part, ok, op });
const retract = (eventTs, kind, id) => ({ type: 'retract', eventTs, kind, id });

test('wear formula is non-linear: seconds * (force / rated)^2', () => {
  assert.equal(wearOf({ force: 100, seconds: 2 }), 2);
  assert.equal(wearOf({ force: 200, seconds: 1 }), 4);
  assert.equal(wearOf({ force: 50, seconds: 4 }), 1);
  assert.equal(RATED_FORCE, 100);
});

test('acceptance 3: wear order enumeration matches expected remaining sequence', () => {
  const result = run([
    change(0, 'T1', 10, 'c1'),
    load(1, 'T1', 'P1', 100, 2, 'l1'), // wear 2 -> remaining 8
    load(2, 'T1', 'P2', 200, 1, 'l2'), // wear 4 -> remaining 4
    load(3, 'T1', 'P3', 50, 4, 'l3'),  // wear 1 -> remaining 3
    load(4, 'T1', 'P4', 100, 4, 'l4'), // wear 4 -> remaining -1 => EXHAUST
  ]);
  const tool = result.tools[0];
  assert.equal(tool.segments.length, 1);
  const segment = tool.segments[0];
  assert.deepEqual(segment.loads.map((l) => l.wear), [2, 4, 1, 4]);
  assert.deepEqual(segment.loads.map((l) => l.remaining), [8, 4, 3, -1]);
  assert.equal(segment.status, 'EXHAUST');
  assert.equal(segment.exhaustedAt, 4);
  assert.equal(tool.status, 'EXHAUST');
  const p4 = result.parts.find((p) => p.part === 'P4');
  assert.equal(p4.risk, 'EXHAUSTED');
  assert.equal(result.parts.find((p) => p.part === 'P1').risk, 'OK');
});

test('acceptance 4: wearing exactly to zero is not EXHAUST', () => {
  const result = run([
    change(0, 'T1', 3, 'c1'),
    load(1, 'T1', 'P1', 100, 1, 'l1'),
    load(2, 'T1', 'P2', 100, 2, 'l2'), // used = 3, remaining = 0 exactly
  ]);
  const tool = result.tools[0];
  assert.equal(tool.remaining, 0);
  assert.equal(tool.status, 'OK');
  assert.equal(tool.exhaustedAt, null);
  assert.deepEqual(result.summary.exhaustedTools, []);
  // one more unit of wear tips it over
  const over = run([
    change(0, 'T1', 3, 'c1'),
    load(1, 'T1', 'P1', 100, 1, 'l1'),
    load(2, 'T1', 'P2', 100, 2, 'l2'),
    load(3, 'T1', 'P3', 50, 1, 'l3'), // wear 0.25 -> remaining -0.25
  ]);
  assert.equal(over.tools[0].status, 'EXHAUST');
  assert.equal(over.tools[0].exhaustedAt, 3);
});

test('acceptance 2: retracting a load rolls back wear and restores the segment', () => {
  const base = [
    change(0, 'T1', 5, 'c1'),
    load(1, 'T1', 'P1', 100, 6, 'l1'), // wear 6 -> EXHAUST
    load(2, 'T1', 'P2', 100, 1, 'l2'), // machined while exhausted
  ];
  const exhausted = run(base);
  assert.equal(exhausted.tools[0].status, 'EXHAUST');
  assert.equal(exhausted.parts.find((p) => p.part === 'P2').risk, 'EXHAUSTED');

  const restored = run([...base, retract(3, 'load', 'l1')]);
  const tool = restored.tools[0];
  assert.equal(tool.status, 'OK');
  assert.equal(tool.used, 1);
  assert.equal(tool.remaining, 4);
  assert.equal(tool.exhaustedAt, null);
  assert.equal(restored.parts.find((p) => p.part === 'P2').risk, 'OK');
  assert.deepEqual(restored.summary.exhaustedTools, []);
});

test('acceptance 1: late qc flips the risk chain of subsequent parts', () => {
  const events = [
    change(0, 'T1', 1000, 'c1'),
    load(10, 'T1', 'A', 100, 1, 'l1'),
    load(20, 'T1', 'B', 100, 1, 'l2'),
    load(30, 'T1', 'C', 100, 1, 'l3'),
    qc(40, 'C', true, 'q1'),
  ];
  const before = run(events);
  assert.deepEqual(before.parts.map((p) => p.risk), ['OK', 'OK', 'OK']);
  assert.equal(before.late.length, 0);

  // qc for A (eventTs 15, not ok) arrives after eventTs 40 was seen: watermark = 36 -> late.
  const after = run([...events, qc(15, 'A', false, 'q2')]);
  assert.equal(after.late.length, 1);
  assert.equal(after.late[0].op, 'q2');
  assert.equal(after.late[0].watermark, 36);
  const byPart = Object.fromEntries(after.parts.map((p) => [p.part, p]));
  assert.equal(byPart.A.state, 'BAD');
  assert.equal(byPart.A.risk, 'OK'); // machined before its own qc
  assert.equal(byPart.B.risk, 'SUSPECT'); // chain: bad qc at 15 covers loads after 15
  assert.equal(byPart.C.risk, 'SUSPECT'); // machined at 30, before the clearing qc at 40
  assert.deepEqual(after.summary.partsAtRisk, ['B', 'C']);
});

test('retracting a GOOD qc pulls the part back to UNKNOWN and reopens the chain', () => {
  const events = [
    change(0, 'T1', 1000, 'c1'),
    load(10, 'T1', 'A', 100, 1, 'l1'),
    load(20, 'T1', 'B', 100, 1, 'l2'),
    load(30, 'T1', 'C', 100, 1, 'l3'),
    qc(12, 'A', false, 'q1'), // opens chain risk
    qc(25, 'B', true, 'q2'),  // clears it before C
  ];
  const cleared = run(events);
  assert.equal(cleared.parts.find((p) => p.part === 'C').risk, 'OK');
  assert.equal(cleared.parts.find((p) => p.part === 'B').state, 'GOOD');

  const reopened = run([...events, retract(26, 'qc', 'q2')]);
  const byPart = Object.fromEntries(reopened.parts.map((p) => [p.part, p]));
  assert.equal(byPart.B.state, 'UNKNOWN'); // GOOD qc retracted
  assert.equal(byPart.B.risk, 'SUSPECT');
  assert.equal(byPart.C.risk, 'SUSPECT'); // chain risk now extends past B
});

test('multiple qc for one part: latest eventTs wins, ties broken by op id', () => {
  const result = run([
    change(0, 'T1', 1000, 'c1'),
    load(1, 'T1', 'A', 100, 1, 'l1'),
    qc(5, 'A', true, 'q1'),
    qc(6, 'A', false, 'q2'), // later eventTs wins
    load(7, 'T1', 'B', 100, 1, 'l2'),
  ]);
  assert.equal(result.parts.find((p) => p.part === 'A').state, 'BAD');
  assert.equal(result.parts.find((p) => p.part === 'B').risk, 'SUSPECT');

  const tie = run([
    change(0, 'T1', 1000, 'c1'),
    load(1, 'T1', 'A', 100, 1, 'l1'),
    qc(5, 'A', true, 'q9'),
    qc(5, 'A', false, 'q2'), // same eventTs, lower id loses
  ]);
  assert.equal(tie.parts.find((p) => p.part === 'A').state, 'GOOD');
  assert.equal(tie.parts.find((p) => p.part === 'A').qc.op, 'q9');
});

test('change with newLife <= 0 is reported as LIFE_INVALID and skipped', () => {
  const result = run([
    change(0, 'T1', 10, 'c1'),
    change(5, 'T1', 0, 'c2'),
    change(6, 'T1', -3, 'c3'),
    load(7, 'T1', 'P1', 100, 1, 'l1'),
  ]);
  const invalid = result.errors.filter((e) => e.code === 'LIFE_INVALID');
  assert.equal(invalid.length, 2);
  assert.deepEqual(invalid.map((e) => e.op), ['c2', 'c3']);
  assert.equal(result.tools[0].segments.length, 1); // invalid changes skipped
  assert.equal(result.tools[0].remaining, 9);
});

test('retracting a change merges the following loads back into the prior segment', () => {
  const events = [
    change(0, 'T1', 10, 'c1'),
    load(1, 'T1', 'P1', 100, 2, 'l1'),
    change(5, 'T1', 20, 'c2'),
    load(6, 'T1', 'P2', 100, 3, 'l2'),
  ];
  const two = run(events);
  assert.equal(two.tools[0].segments.length, 2);
  assert.equal(two.tools[0].remaining, 17);

  const merged = run([...events, retract(7, 'change', 'c2')]);
  assert.equal(merged.tools[0].segments.length, 1);
  assert.equal(merged.tools[0].used, 5);
  assert.equal(merged.tools[0].remaining, 5);
});

test('watermark and maxEventTs are exposed in the summary', () => {
  const result = run([change(0, 'T1', 10, 'c1'), load(12, 'T1', 'P1', 100, 1, 'l1')]);
  assert.equal(result.summary.maxEventTs, 12);
  assert.equal(result.summary.watermark, 8);
});
