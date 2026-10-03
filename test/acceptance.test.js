import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, rankDiff, E_CYCLE } from '../src/engine.js';
import { idCompare } from '../src/canonical.js';

// ---- independent brute-force reference implementation ----

function referenceResolve(hid, hypotheses, studies, visiting) {
  if (visiting.has(hid)) throw new Error('cycle');
  const hyp = hypotheses.get(hid);
  if (!hyp || hyp.refs.length === 0) return { usable: false, studies: new Set() };
  visiting.add(hid);
  const parts = hyp.refs.map((ref) => {
    if (ref.kind === 'study') {
      const s = studies.get(ref.id);
      return s && s.active
        ? { usable: true, studies: new Set([ref.id]) }
        : { usable: false, studies: new Set() };
    }
    return referenceResolve(ref.id, hypotheses, studies, visiting);
  });
  visiting.delete(hid);
  const union = new Set();
  if (hyp.combinator === 'all') {
    const usable = parts.every((p) => p.usable);
    if (usable) for (const p of parts) for (const id of p.studies) union.add(id);
    return { usable, studies: union };
  }
  const usable = parts.some((p) => p.usable);
  if (usable) for (const p of parts) for (const id of p.studies) union.add(id);
  return { usable, studies: union };
}

function referenceState(engine) {
  const scores = new Map();
  const excluded = [];
  for (const hid of engine.hypotheses.keys()) {
    const { usable, studies } = referenceResolve(hid, engine.hypotheses, engine.studies, new Set());
    const included = [...studies]
      .filter((sid) => engine.studies.get(sid).weight > 0)
      .sort(idCompare);
    let sumW = 0;
    let sumWE = 0;
    for (const sid of included) {
      const s = engine.studies.get(sid);
      sumW += s.weight;
      sumWE += s.weight * s.effect;
    }
    if (!usable || included.length === 0) {
      scores.set(hid, null);
      excluded.push(hid);
    } else {
      scores.set(hid, sumWE / sumW);
    }
  }
  const ranking = [...scores.entries()]
    .filter(([, score]) => score !== null)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || idCompare(a.id, b.id))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  excluded.sort(idCompare);
  return { ranking, excluded };
}

function assertMatchesReference(engine) {
  const ref = referenceState(engine);
  assert.deepEqual(engine.snapshot(), ref, 'incremental state diverges from full recompute');
  for (const [hid, cached] of engine.cache) {
    const cert = engine.certificate(hid);
    assert.equal(cert.excluded, cached.excluded);
    assert.deepEqual(cert.includedStudies, cached.included);
  }
}

// ---- deterministic PRNG ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 1: incremental engine matches full recompute (<=6 hypotheses, <=10 studies)', () => {
  for (const seed of [1, 7, 42, 1337, 20261003]) {
    const rand = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const engine = new Engine();
    const nH = 1 + Math.floor(rand() * 6); // 1..6 hypotheses
    const nS = 1 + Math.floor(rand() * 10); // 1..10 studies
    const hids = Array.from({ length: nH }, (_, i) => 'H' + i);
    const sids = Array.from({ length: nS }, (_, i) => 'S' + i);

    for (let step = 0; step < 60; step++) {
      const roll = rand();
      if (roll < 0.35) {
        const id = pick(sids);
        engine.setStudy(id, {
          weight: Math.floor(rand() * 4), // includes zero weights
          effect: Math.round(rand() * 400) / 100 - 2,
          active: rand() > 0.2,
        });
      } else if (roll < 0.5) {
        engine.retractStudy(pick(sids));
      } else if (roll < 0.6) {
        const id = pick(sids);
        engine.correctStudy(id, { weight: Math.floor(rand() * 4) });
      } else if (roll < 0.85) {
        const idx = Math.floor(rand() * nH);
        const refs = [];
        const nRefs = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < nRefs; k++) {
          if (rand() < 0.6 || idx === 0) {
            refs.push({ kind: 'study', id: pick(sids) });
          } else {
            // only reference lower-index hypotheses: acyclic by construction
            refs.push({ kind: 'hypothesis', id: hids[Math.floor(rand() * idx)] });
          }
        }
        engine.setHypothesis(hids[idx], {
          combinator: rand() < 0.5 ? 'all' : 'any',
          refs,
        });
      } else {
        const idx = 1 + Math.floor(rand() * (nH - 1));
        const target = hids[idx];
        if (engine.hypotheses.has(target)) {
          const ref = rand() < 0.5
            ? { kind: 'study', id: pick(sids) }
            : { kind: 'hypothesis', id: hids[Math.floor(rand() * idx)] };
          if (rand() < 0.5) engine.addEdge(target, ref);
          else engine.removeEdge(target, ref);
        }
      }
      assertMatchesReference(engine);
    }
  }
});

test('acceptance 2: retracting a key study yields minimal rank diff and fixed tie order', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setStudy('s2', { weight: 1, effect: 1 });
  engine.setStudy('s3', { weight: 1, effect: 1 });
  engine.setStudy('key', { weight: 10, effect: 5 });
  // A, B, C tie at 1.0 -> fixed id order A, B, C; D leads via the key study.
  for (const [hid, sid] of [['A', 's1'], ['B', 's2'], ['C', 's3']]) {
    engine.setHypothesis(hid, { combinator: 'all', refs: [{ kind: 'study', id: sid }] });
  }
  engine.setHypothesis('D', {
    combinator: 'any',
    refs: [{ kind: 'study', id: 'key' }, { kind: 'study', id: 's1' }],
  });
  assert.deepEqual(engine.ranking.map((e) => e.id), ['D', 'A', 'B', 'C']);

  const before = engine.snapshot().ranking;
  engine.retractStudy('key');
  const after = engine.snapshot().ranking;

  // D drops into the tie at 1.0; tie order is fixed by id ascending, so D takes
  // the last tied slot and A/B/C each shift up exactly one rank (minimal diff).
  assert.deepEqual(rankDiff(before, after), [
    { id: 'A', from: 2, to: 1 },
    { id: 'B', from: 3, to: 2 },
    { id: 'C', from: 4, to: 3 },
    { id: 'D', from: 1, to: 4 },
  ]);
  assert.deepEqual(after.map((e) => e.id), ['A', 'B', 'C', 'D']);

  // Retracting s1 as well: A and D become excluded, B and C keep ranks 1..2.
  const before2 = engine.snapshot().ranking;
  engine.retractStudy('s1');
  const after2 = engine.snapshot().ranking;
  assert.deepEqual(rankDiff(before2, after2), [
    { id: 'A', from: 1, to: null },
    { id: 'B', from: 2, to: 1 },
    { id: 'C', from: 3, to: 2 },
    { id: 'D', from: 4, to: null },
  ]);
  assert.deepEqual(after2.map((e) => e.id), ['B', 'C']);
  assert.deepEqual(engine.excluded, ['A', 'D']);
});

test('acceptance 3a: zero weight conventions', () => {
  const engine = new Engine();
  engine.setStudy('z', { weight: 0, effect: 99 });
  engine.setHypothesis('H', { combinator: 'all', refs: [{ kind: 'study', id: 'z' }] });
  assert.deepEqual(engine.ranking, []);
  assert.deepEqual(engine.excluded, ['H']);
  const cert = engine.certificate('H');
  assert.deepEqual(cert.includedStudies, []);
  assert.equal(cert.score, null);
  assert.equal(cert.rank, null);
});

test('acceptance 3b: cycle ops are rejected with E_CYCLE, state intact', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 2 });
  engine.setHypothesis('X', { combinator: 'all', refs: [{ kind: 'study', id: 's1' }] });
  engine.setHypothesis('Y', { combinator: 'all', refs: [{ kind: 'hypothesis', id: 'X' }] });
  const res = engine.setHypothesis('X', {
    combinator: 'all',
    refs: [{ kind: 'hypothesis', id: 'Y' }],
  });
  assert.equal(res.error, E_CYCLE);
  assert.deepEqual(engine.ranking.map((e) => e.id), ['X', 'Y']);
  assert.equal(engine.cache.get('X').score, 2);
  assert.equal(engine.cache.get('Y').score, 2);
});

test('acceptance 3c: retracting everything empties the ranking', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setStudy('s2', { weight: 2, effect: 2 });
  engine.setHypothesis('H1', { combinator: 'any', refs: [{ kind: 'study', id: 's1' }, { kind: 'study', id: 's2' }] });
  engine.setHypothesis('H2', { combinator: 'all', refs: [{ kind: 'hypothesis', id: 'H1' }] });
  engine.retractStudy('s1');
  engine.retractStudy('s2');
  assert.deepEqual(engine.ranking, []);
  assert.deepEqual(engine.excluded, ['H1', 'H2']);
  assert.ok(engine.certificates().every((c) => c.rank === null && c.excluded));
});

test('acceptance 3d: same-seq conflicts resolve deterministically', () => {
  const ops = [
    { seq: 1, authorId: 'carol', type: 'study.upsert', id: 's1', weight: 1, effect: 3 },
    { seq: 1, authorId: 'alice', type: 'study.upsert', id: 's1', weight: 1, effect: 1 },
    { seq: 1, authorId: 'bob', type: 'study.upsert', id: 's1', weight: 1, effect: 2 },
    { seq: 1, authorId: 'bob', type: 'study.upsert', id: 's1', weight: 1, effect: 8 },
    { seq: 2, authorId: 'alice', type: 'hypothesis.set', id: 'H', combinator: 'all', refs: [{ kind: 'study', id: 's1' }] },
  ];
  const run = (input) => {
    const engine = new Engine();
    const report = engine.replay(input);
    return { snap: engine.snapshot(), cert: engine.certificate('H'), report };
  };
  const forward = run(ops);
  const reversed = run([...ops].reverse());
  // deterministic regardless of arrival order
  assert.deepEqual(reversed.snap, forward.snap);
  assert.deepEqual(reversed.cert, forward.cert);
  // same seq -> authorId ascending; duplicate (seq, authorId) flagged as conflict
  const conflicts = forward.report.filter((r) => r.conflict);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].authorId, 'bob');
  // order: alice(1) -> bob(2) -> bob(8) -> carol(3); last writer carol wins
  assert.equal(forward.cert.score, 3);
});
