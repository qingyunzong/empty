'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonl, runEngine } = require('../src/engine');

const load = (eventTs, tool, part, force, seconds, op) => ({
  type: 'load', eventTs, tool, part, force, seconds, op,
});
const change = (eventTs, tool, newLife, op) => ({ type: 'change', eventTs, tool, newLife, op });
const qc = (eventTs, part, ok, op) => ({ type: 'qc', eventTs, part, ok, op });
const retract = (eventTs, kind, id) => ({ type: 'retract', eventTs, kind, id });

const partRisk = (res, part) => res.parts.find((p) => p.part === part).risk;

test('acceptance 3: wear order enumeration matches hand-computed sequence', () => {
  // rated force = 100 (default); wear = seconds * (force/100)^2
  const res = runEngine([
    change(0, 'T1', 10, 'c1'),
    load(1000, 'T1', 'P1', 100, 1, 'l1'), // wear 1 * 1^2   = 1
    load(2000, 'T1', 'P2', 200, 1, 'l2'), // wear 1 * 2^2   = 4
    load(3000, 'T1', 'P3', 50, 2, 'l3'),  // wear 2 * 0.5^2 = 0.5
    load(4000, 'T1', 'P4', 0, 5, 'l4'),   // wear 0
  ]);
  const seq = res.loads.map((r) => [r.op, r.wear, r.cumWear, r.remaining]);
  assert.deepEqual(seq, [
    ['l1', 1, 1, 9],
    ['l2', 4, 5, 5],
    ['l3', 0.5, 5.5, 4.5],
    ['l4', 0, 5.5, 4.5],
  ]);
  const seg = res.tools[0].segments[0];
  assert.equal(seg.wear, 5.5);
  assert.equal(seg.remaining, 4.5);
  assert.equal(seg.exhausted, false);
  assert.deepEqual(res.exhausts, []);
});

test('acceptance 4: wear exactly to zero remaining is NOT exhaust', () => {
  const res = runEngine([
    change(0, 'T1', 4, 'c1'),
    load(1000, 'T1', 'P1', 200, 1, 'l1'), // wear exactly 4 -> remaining 0
  ]);
  assert.equal(res.tools[0].segments[0].remaining, 0);
  assert.equal(res.tools[0].segments[0].exhausted, false);
  assert.equal(res.loads[0].exhausted, false);
  assert.deepEqual(res.exhausts, []);
  assert.equal(partRisk(res, 'P1'), 'UNKNOWN'); // no qc, not exhausted

  // one more epsilon of wear crosses the line -> EXHAUST at that moment
  const res2 = runEngine([
    change(0, 'T1', 4, 'c1'),
    load(1000, 'T1', 'P1', 200, 1, 'l1'),
    load(2000, 'T1', 'P2', 100, 0.1, 'l2'), // cum 4.1 > 4
  ]);
  assert.equal(res2.tools[0].segments[0].exhausted, true);
  assert.equal(res2.tools[0].segments[0].exhaustAt, 2000);
  assert.deepEqual(res2.exhausts, [
    { tool: 'T1', op: 'l2', eventTs: 2000, wear: 4.1, newLife: 4 },
  ]);
  assert.equal(res2.loads[0].exhausted, false); // boundary load itself still fine
  assert.equal(res2.loads[1].exhausted, true);
  assert.equal(partRisk(res2, 'P2'), 'RISK');
});

test('acceptance 2: retracting a load rolls back wear and restores segments', () => {
  const base = [
    change(0, 'T1', 1, 'c1'),
    load(1000, 'T1', 'P1', 100, 0.5, 'l1'), // cum 0.5
    load(2000, 'T1', 'P2', 100, 0.6, 'l2'), // cum 1.1 -> EXHAUST
    load(3000, 'T1', 'P3', 100, 0.1, 'l3'), // cum 1.2, still exhausted
  ];
  const before = runEngine(base);
  assert.equal(before.tools[0].segments[0].exhausted, true);
  assert.equal(before.exhausts.length, 1);
  assert.equal(partRisk(before, 'P2'), 'RISK');
  assert.equal(partRisk(before, 'P3'), 'RISK');

  const after = runEngine([...base, retract(4000, 'load', 'l2')]);
  const seg = after.tools[0].segments[0];
  assert.equal(seg.wear, 0.6); // 0.5 + 0.1, l2 rolled back
  assert.equal(seg.exhausted, false);
  assert.deepEqual(after.exhausts, []);
  assert.equal(partRisk(after, 'P1'), 'UNKNOWN');
  assert.equal(partRisk(after, 'P3'), 'UNKNOWN');
  assert.equal(after.parts.some((p) => p.part === 'P2'), false); // load gone, part gone
});

test('acceptance 1: late qc flips the risk chain of later parts on the tool', () => {
  const loads = [
    change(0, 'T1', 1000, 'c1'),
    load(10000, 'T1', 'P1', 100, 1, 'l1'),
    load(20000, 'T1', 'P2', 100, 1, 'l2'),
    load(30000, 'T1', 'P3', 100, 1, 'l3'),
  ];
  const calm = runEngine(loads);
  assert.deepEqual(
    calm.parts.map((p) => [p.part, p.risk]),
    [['P1', 'UNKNOWN'], ['P2', 'UNKNOWN'], ['P3', 'UNKNOWN']]
  );

  // qc for P1 arrives after the stream already advanced to ts=30000:
  // watermark = 30000 - 4000 = 26000 > 15000 -> late.
  const lateQc = qc(15000, 'P1', false, 'q1');
  const res = runEngine([...loads, lateQc]);
  assert.deepEqual(res.late, [
    { kind: 'qc', id: 'q1', eventTs: 15000, watermark: 26000 },
  ]);
  assert.equal(partRisk(res, 'P1'), 'BAD');
  assert.equal(partRisk(res, 'P2'), 'RISK'); // chain: suspicion propagates forward
  assert.equal(partRisk(res, 'P3'), 'RISK');

  // retracting the qc pulls the whole chain back
  const undone = runEngine([...loads, lateQc, retract(40000, 'qc', 'q1')]);
  assert.deepEqual(
    undone.parts.map((p) => [p.part, p.risk]),
    [['P1', 'UNKNOWN'], ['P2', 'UNKNOWN'], ['P3', 'UNKNOWN']]
  );
});

test('qc retract pulls part from GOOD back to UNKNOWN and recomputes downstream risk', () => {
  // P1 BAD would taint P2; a GOOD qc on P2 resets the chain for P3.
  const events = [
    change(0, 'T1', 1000, 'c1'),
    load(1000, 'T1', 'P1', 100, 1, 'l1'),
    load(2000, 'T1', 'P2', 100, 1, 'l2'),
    load(3000, 'T1', 'P3', 100, 1, 'l3'),
    qc(1500, 'P1', false, 'q1'), // P1 BAD
    qc(2500, 'P2', true, 'q2'),  // P2 GOOD -> chain reset
  ];
  const res = runEngine(events);
  assert.equal(partRisk(res, 'P1'), 'BAD');
  assert.equal(partRisk(res, 'P2'), 'GOOD');
  assert.equal(partRisk(res, 'P3'), 'UNKNOWN'); // reset by P2's GOOD qc

  // retract P2's GOOD qc: P2 falls back to UNKNOWN->RISK (after BAD P1),
  // and P3 is recomputed to RISK as well.
  const res2 = runEngine([...events, retract(4000, 'qc', 'q2')]);
  assert.equal(partRisk(res2, 'P2'), 'RISK');
  assert.equal(partRisk(res2, 'P3'), 'RISK');
});

test('multiple qc on one part: latest eventTs wins, tie broken by greatest op id', () => {
  const events = [
    change(0, 'T1', 1000, 'c1'),
    load(1000, 'T1', 'P1', 100, 1, 'l1'),
    qc(5000, 'P1', true, 'qa'),
    qc(5000, 'P1', false, 'qb'), // same ts, greater id wins -> BAD
    qc(4000, 'P1', true, 'q1'),  // older, ignored
  ];
  const res = runEngine(events);
  const p = res.parts.find((x) => x.part === 'P1');
  assert.equal(p.qc, 'BAD');
  assert.equal(p.qcOp, 'qb');
  assert.equal(p.risk, 'BAD');

  // retract the winner -> the remaining latest (qa, ok) applies
  const res2 = runEngine([...events, retract(6000, 'qc', 'qb')]);
  const p2 = res2.parts.find((x) => x.part === 'P1');
  assert.equal(p2.qc, 'GOOD');
  assert.equal(p2.qcOp, 'qa');
  assert.equal(p2.risk, 'GOOD');
});

test('change starts a new life segment; LIFE_INVALID for newLife <= 0', () => {
  const res = runEngine([
    change(0, 'T1', 1, 'c1'),
    load(1000, 'T1', 'P1', 100, 2, 'l1'), // cum 2 > 1 -> exhaust seg 1
    change(2000, 'T1', 0, 'c2'),          // invalid, skipped
    change(3000, 'T1', 10, 'c3'),         // fresh segment
    load(4000, 'T1', 'P2', 100, 1, 'l2'), // wear counted in seg 2
  ]);
  assert.deepEqual(
    res.errors.filter((e) => e.code === 'LIFE_INVALID'),
    [{ code: 'LIFE_INVALID', tool: 'T1', op: 'c2', newLife: 0 }]
  );
  const segs = res.tools[0].segments;
  assert.equal(segs.length, 2); // c2 skipped
  assert.equal(segs[0].exhausted, true);
  assert.equal(segs[1].op, 'c3');
  assert.equal(segs[1].wear, 1);
  assert.equal(segs[1].exhausted, false);
  assert.equal(partRisk(res, 'P1'), 'RISK');
  assert.equal(partRisk(res, 'P2'), 'UNKNOWN');
});

test('load before any change is untracked; retract of missing op is reported', () => {
  const res = runEngine([
    load(1000, 'T1', 'P1', 100, 5, 'l1'),
    retract(2000, 'load', 'nope'),
  ]);
  assert.equal(res.tools[0].untrackedLoads, 1);
  assert.equal(res.loads[0].untracked, true);
  assert.equal(res.loads[0].exhausted, false);
  assert.deepEqual(res.errors, [{ code: 'RETRACT_MISS', kind: 'load', id: 'nope' }]);
});

test('parseJsonl collects parse and validation errors', () => {
  const { events, errors } = parseJsonl(
    '{"type":"qc","eventTs":1,"part":"P1","ok":true,"op":"q1"}\n' +
      'not json\n' +
      '{"type":"load","eventTs":2,"tool":"T1","part":"P1","force":-3,"seconds":1,"op":"l1"}\n'
  );
  assert.equal(events.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].code, 'PARSE_ERROR');
  assert.equal(errors[1].code, 'EVENT_INVALID');
});
