import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph, ERR } from '../src/evidence.js';

test('zero-weight studies contribute nothing; all-zero weights exclude the claim', () => {
  const graph = new EvidenceGraph();
  graph.addStudy('s0', { weight: 0, effect: 5 });
  graph.addStudy('s1', { weight: 2, effect: 0.5 });
  graph.addClaim('h1', { op: 'any', refs: ['s0', 's1'] });
  graph.addClaim('h2', { op: 'any', refs: ['s0'] });

  const ranking = graph.getRanking();
  assert.equal(ranking.length, 1);
  assert.equal(ranking[0].id, 'h1');
  assert.equal(ranking[0].score, 0.5);
  assert.deepEqual(graph.getCertificate('h1').studies, ['s0', 's1']);

  const h2 = graph.getCertificate('h2');
  assert.equal(h2.status, 'excluded');
  assert.equal(h2.reason, 'zero_total_weight');
  assert.equal(h2.rank, null);
  assert.equal(h2.score, null);
  assert.deepEqual(graph.getExcluded(), [{ id: 'h2', status: 'excluded', reason: 'zero_total_weight' }]);
});

test('negative or non-finite weights are rejected', () => {
  const graph = new EvidenceGraph();
  assert.throws(() => graph.addStudy('s1', { weight: -1, effect: 0 }), (e) => e.code === ERR.INVALID);
  assert.throws(() => graph.addStudy('s1', { weight: Number.NaN, effect: 0 }), (e) => e.code === ERR.INVALID);
  graph.addStudy('s1', { weight: 1, effect: 0 });
  assert.throws(() => graph.setWeight('s1', Number.POSITIVE_INFINITY), (e) => e.code === ERR.INVALID);
});

test('reference cycles yield E_CYCLE and are excluded from ranking until broken', () => {
  const graph = new EvidenceGraph();
  graph.addStudy('s1', { weight: 1, effect: 0.3 });
  graph.addClaim('h1', { op: 'any', refs: ['h2'] });
  graph.addClaim('h2', { op: 'any', refs: ['h1', 's1'] });
  graph.addClaim('h3', { op: 'any', refs: ['s1'] });

  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h3']);
  for (const id of ['h1', 'h2']) {
    const cert = graph.getCertificate(id);
    assert.equal(cert.status, 'error');
    assert.equal(cert.error, ERR.CYCLE);
    assert.equal(cert.rank, null);
  }

  graph.removeEdge('h1', 'h2');
  // h1 has no refs left and drops out; h2 and h3 tie at 0.3, id order wins
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h2', 'h3']);
  assert.deepEqual(graph.getExcluded(), [{ id: 'h1', status: 'excluded', reason: 'no_valid_studies' }]);
});

test('self-loop is a cycle', () => {
  const graph = new EvidenceGraph();
  graph.addClaim('h1', { op: 'any', refs: ['h1'] });
  assert.equal(graph.getCertificate('h1').error, ERR.CYCLE);
});

test('retracting every study empties the ranking', () => {
  const graph = new EvidenceGraph();
  graph.addStudy('s1', { weight: 1, effect: 0.1 });
  graph.addStudy('s2', { weight: 2, effect: 0.2 });
  graph.addClaim('h1', { op: 'any', refs: ['s1'] });
  graph.addClaim('h2', { op: 'all', refs: ['s1', 's2'] });
  assert.equal(graph.getRanking().length, 2);

  graph.retractStudy('s1');
  graph.retractStudy('s2');
  assert.deepEqual(graph.getRanking(), []);
  assert.deepEqual(
    graph.getExcluded(),
    [
      { id: 'h1', status: 'excluded', reason: 'no_valid_studies' },
      { id: 'h2', status: 'excluded', reason: 'no_valid_studies' },
    ],
  );

  graph.restoreStudy('s2');
  // h2 uses op 'all', so it stays excluded until s1 is restored as well
  assert.deepEqual(graph.getRanking(), []);
  graph.restoreStudy('s1');
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h2', 'h1']);
});

test('duplicate (seq, authorId) is a conflict: nothing is applied', () => {
  const graph = new EvidenceGraph();
  const result = graph.replay([
    { seq: 1, authorId: 'amy', type: 'add_study', id: 's1', weight: 1, effect: 0.1 },
    { seq: 1, authorId: 'amy', type: 'add_study', id: 's2', weight: 1, effect: 0.2 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.applied, 0);
  assert.equal(result.errors[0].code, ERR.SEQ_CONFLICT);
  assert.equal(graph.studies.size, 0);
});

test('same seq with different authors replays deterministically by authorId', () => {
  const ops = [
    { seq: 1, authorId: 'amy', type: 'add_study', id: 's1', weight: 1, effect: 0.5 },
    { seq: 2, authorId: 'zoe', type: 'set_weight', id: 's1', weight: 5 },
    { seq: 2, authorId: 'bob', type: 'set_weight', id: 's1', weight: 7 },
    { seq: 3, authorId: 'amy', type: 'add_claim', id: 'h1', op: 'any', refs: ['s1'] },
  ];
  const first = new EvidenceGraph();
  first.replay(ops);
  const second = new EvidenceGraph();
  second.replay([...ops].reverse());
  // bob < zoe, so bob's weight=7 is overwritten by zoe's weight=5
  assert.equal(first.studies.get('s1').weight, 5);
  assert.deepEqual(first.getRanking(), second.getRanking());
  assert.deepEqual(first.getCertificate('h1'), second.getCertificate('h1'));
});

test('certificate hash is stable and covers studies, score, and rank', () => {
  const build = () => {
    const graph = new EvidenceGraph();
    graph.addStudy('s1', { weight: 2, effect: 0.4 });
    graph.addStudy('s2', { weight: 1, effect: 0.1 });
    graph.addClaim('h1', { op: 'any', refs: ['s1', 's2'] });
    return graph;
  };
  const a = build().getCertificate('h1');
  const b = build().getCertificate('h1');
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);

  const changed = build();
  changed.setWeight('s1', 3);
  assert.notEqual(changed.getCertificate('h1').hash, a.hash);
});
