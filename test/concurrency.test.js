import test from 'node:test';
import assert from 'node:assert/strict';
import { CausalGraph } from '../src/eventlog.js';
import { replay } from '../src/replay.js';
import { budgetSet, cut, measure, writeLog, runCli } from '../support/helpers.js';

// Acceptance 3: concurrency (happens-before) determination must match brute-force
// enumeration of all linear extensions, for histories of up to 7 events.

function allLinearExtensions(events) {
  const indeg = new Map(events.map((e) => [e.id, e.causes.length]));
  const children = new Map(events.map((e) => [e.id, []]));
  for (const e of events) for (const c of e.causes) children.get(c).push(e.id);
  const out = [];
  const current = [];
  (function bt() {
    if (current.length === events.length) { out.push([...current]); return; }
    for (const e of events) {
      if (indeg.get(e.id) !== 0) continue;
      indeg.set(e.id, -1);
      current.push(e.id);
      for (const ch of children.get(e.id)) indeg.set(ch, indeg.get(ch) - 1);
      bt();
      for (const ch of children.get(e.id)) indeg.set(ch, indeg.get(ch) + 1);
      current.pop();
      indeg.set(e.id, 0);
    }
  })();
  return out;
}

function bruteForceConcurrent(events, a, b) {
  const les = allLinearExtensions(events);
  let aBeforeB = false;
  let bBeforeA = false;
  for (const le of les) {
    if (le.indexOf(a) < le.indexOf(b)) aBeforeB = true;
    else bBeforeA = true;
  }
  return aBeforeB && bBeforeA;
}

function randomLog(rng, n) {
  const events = budgetSet({ segment: 100000 });
  for (let i = 0; i < n; i += 1) {
    const id = `e${i}`;
    const tool = rng() < 0.5 ? 'T1' : 'T2';
    const type = rng() < 0.5 ? 'cut' : 'measure';
    const candidates = events.filter((e) => e.tool === tool || e.type === 'budget').map((e) => e.id);
    const causes = candidates.filter(() => rng() < 0.3);
    events.push({ type, id, tool, order: 'O1', op: 'P1', seg: 'S1', length: 1, causes });
  }
  return events;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('happens-before matches enumeration of all linear extensions (<=7 events)', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = mulberry32(seed);
    const n = 1 + Math.floor(rng() * 7); // 1..7 usage events
    const events = randomLog(rng, n);
    const graph = new CausalGraph(events);
    const ids = events.map((e) => e.id);
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const expected = bruteForceConcurrent(events, a, b);
        assert.equal(
          graph.concurrent(a, b), expected,
          `seed=${seed} pair=(${a},${b}) causes=${JSON.stringify(events.map((e) => [e.id, e.causes]))}`,
        );
      }
    }
  }
});

test('conflict detection is independent of log line order', () => {
  const base = [
    ...budgetSet({ segment: 1000 }),
    cut('c1', 10),
    measure('m1', 5), // concurrent with c1 on T1
    cut('c2', 10, ['c1']),
  ];
  const expected = { a: 'c1', b: 'm1' };
  for (let seed = 1; seed <= 20; seed += 1) {
    const rng = mulberry32(seed);
    const shuffled = [...base];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    assert.throws(
      () => replay(shuffled),
      (e) => e.kind === 'CONFLICT' && e.details.a === expected.a && e.details.b === expected.b,
    );
  }
});

test('concurrent measure vs cut exits 14 and reports both ids', () => {
  const log = [...budgetSet({ segment: 1000 }), cut('c1', 10), measure('m1', 5)];
  const r = runCli(['replay', writeLog(log)]);
  assert.equal(r.code, 14);
  const err = r.errJson().error;
  assert.equal(err.kind, 'CONFLICT');
  assert.equal(err.a, 'c1');
  assert.equal(err.b, 'm1');
});

test('causally ordered measure and cut on the same tool is not a conflict', () => {
  const log = [...budgetSet({ segment: 1000 }), cut('c1', 10), measure('m1', 5, ['c1'])];
  const r = replay(log);
  assert.equal(r.exitCode, 0);
});

test('concurrent events on different tools do not conflict', () => {
  const log = [
    ...budgetSet({ segment: 1000 }),
    cut('c1', 10, [], 'T1'),
    measure('m1', 5, [], 'T2'),
  ];
  const r = replay(log);
  assert.equal(r.exitCode, 0);
});
