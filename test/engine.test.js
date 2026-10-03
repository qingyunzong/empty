import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, rankDiff, E_CYCLE, E_NOT_FOUND } from '../src/engine.js';
import { canonical, sha256hex } from '../src/canonical.js';

test('weighted average of available studies', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setStudy('s2', { weight: 3, effect: 3 });
  engine.setHypothesis('H', {
    combinator: 'any',
    refs: [{ kind: 'study', id: 's1' }, { kind: 'study', id: 's2' }],
  });
  assert.equal(engine.cache.get('H').score, (1 * 1 + 3 * 3) / 4);
  assert.equal(engine.ranking[0].id, 'H');
});

test('all combinator requires every reference usable', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 2 });
  engine.setHypothesis('H', {
    combinator: 'all',
    refs: [{ kind: 'study', id: 's1' }, { kind: 'study', id: 'missing' }],
  });
  assert.equal(engine.cache.get('H').excluded, true);
});

test('any combinator keeps usable references only', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 2 });
  engine.setHypothesis('H', {
    combinator: 'any',
    refs: [{ kind: 'study', id: 's1' }, { kind: 'study', id: 'missing' }],
  });
  assert.equal(engine.cache.get('H').excluded, false);
  assert.deepEqual(engine.cache.get('H').included, ['s1']);
});

test('nested hypotheses propagate usability', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 4 });
  engine.setHypothesis('inner', { combinator: 'all', refs: [{ kind: 'study', id: 's1' }] });
  engine.setHypothesis('outer', {
    combinator: 'all',
    refs: [{ kind: 'hypothesis', id: 'inner' }],
  });
  assert.equal(engine.cache.get('outer').score, 4);
  engine.retractStudy('s1');
  assert.equal(engine.cache.get('inner').excluded, true);
  assert.equal(engine.cache.get('outer').excluded, true);
  assert.deepEqual(engine.ranking, []);
  assert.deepEqual(engine.excluded, ['inner', 'outer']);
});

test('retraction and weight correction recompute affected hypotheses', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setStudy('s2', { weight: 1, effect: 5 });
  engine.setHypothesis('H', {
    combinator: 'any',
    refs: [{ kind: 'study', id: 's1' }, { kind: 'study', id: 's2' }],
  });
  assert.equal(engine.cache.get('H').score, 3);
  const res = engine.correctStudy('s2', { weight: 3 });
  assert.deepEqual(res.affected, ['H']);
  assert.equal(engine.cache.get('H').score, (1 + 15) / 4);
  engine.retractStudy('s2');
  assert.equal(engine.cache.get('H').score, 1);
});

test('edge add/remove updates topology incrementally', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setStudy('s2', { weight: 1, effect: 9 });
  engine.setHypothesis('H', { combinator: 'any', refs: [{ kind: 'study', id: 's1' }] });
  assert.equal(engine.cache.get('H').score, 1);
  engine.addEdge('H', { kind: 'study', id: 's2' });
  assert.equal(engine.cache.get('H').score, 5);
  engine.removeEdge('H', { kind: 'study', id: 's2' });
  assert.equal(engine.cache.get('H').score, 1);
});

test('cycle returns E_CYCLE and leaves state unchanged', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setHypothesis('A', { combinator: 'all', refs: [{ kind: 'study', id: 's1' }] });
  engine.setHypothesis('B', { combinator: 'all', refs: [{ kind: 'hypothesis', id: 'A' }] });
  const res = engine.addEdge('A', { kind: 'hypothesis', id: 'B' });
  assert.equal(res.error, E_CYCLE);
  assert.deepEqual(engine.hypotheses.get('A').refs, [{ kind: 'study', id: 's1' }]);
  const selfLoop = engine.setHypothesis('A', {
    combinator: 'all',
    refs: [{ kind: 'hypothesis', id: 'A' }],
  });
  assert.equal(selfLoop.error, E_CYCLE);
});

test('zero-weight studies are ignored; all-zero means excluded', () => {
  const engine = new Engine();
  engine.setStudy('zero', { weight: 0, effect: 100 });
  engine.setStudy('real', { weight: 2, effect: 3 });
  engine.setHypothesis('mixed', {
    combinator: 'any',
    refs: [{ kind: 'study', id: 'zero' }, { kind: 'study', id: 'real' }],
  });
  engine.setHypothesis('onlyZero', { combinator: 'all', refs: [{ kind: 'study', id: 'zero' }] });
  assert.equal(engine.cache.get('mixed').score, 3);
  assert.deepEqual(engine.cache.get('mixed').included, ['real']);
  assert.equal(engine.cache.get('onlyZero').excluded, true);
  assert.deepEqual(engine.excluded, ['onlyZero']);
});

test('all studies retracted: every hypothesis excluded, ranking empty', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 1 });
  engine.setHypothesis('H', { combinator: 'all', refs: [{ kind: 'study', id: 's1' }] });
  engine.retractStudy('s1');
  assert.deepEqual(engine.ranking, []);
  assert.deepEqual(engine.excluded, ['H']);
  const cert = engine.certificate('H');
  assert.equal(cert.rank, null);
  assert.equal(cert.score, null);
  assert.equal(cert.excluded, true);
});

test('ties broken by hypothesis id ascending', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 1, effect: 2 });
  engine.setStudy('s2', { weight: 1, effect: 2 });
  engine.setHypothesis('B', { combinator: 'all', refs: [{ kind: 'study', id: 's1' }] });
  engine.setHypothesis('A', { combinator: 'all', refs: [{ kind: 'study', id: 's2' }] });
  assert.deepEqual(engine.ranking.map((e) => e.id), ['A', 'B']);
});

test('certificate contains studies, score, rank and stable hash', () => {
  const engine = new Engine();
  engine.setStudy('s1', { weight: 2, effect: 1.5 });
  engine.setHypothesis('H', { combinator: 'all', refs: [{ kind: 'study', id: 's1' }] });
  const cert = engine.certificate('H');
  const body = {
    hypothesis: 'H',
    includedStudies: ['s1'],
    score: 1.5,
    rank: 1,
    excluded: false,
  };
  assert.deepEqual({ ...cert, hash: undefined }, { ...body, hash: undefined });
  assert.equal(cert.hash, sha256hex(canonical(body)));
  assert.equal(engine.certificate('nope').error, E_NOT_FOUND);
});

test('replay orders by (seq, authorId) and flags same-key conflicts deterministically', () => {
  const ops = [
    { seq: 2, authorId: 'bob', type: 'study.upsert', id: 's1', weight: 1, effect: 9 },
    { seq: 1, authorId: 'zoe', type: 'study.upsert', id: 's1', weight: 1, effect: 1 },
    { seq: 1, authorId: 'amy', type: 'study.upsert', id: 's1', weight: 1, effect: 5 },
    { seq: 1, authorId: 'amy', type: 'study.upsert', id: 's1', weight: 1, effect: 7 },
    { seq: 3, authorId: 'amy', type: 'hypothesis.set', id: 'H', combinator: 'all', refs: [{ kind: 'study', id: 's1' }] },
  ];
  const engine = new Engine();
  const report = engine.replay(ops);
  assert.deepEqual(
    report.map((r) => [r.seq, r.authorId, r.conflict]),
    [[1, 'amy', false], [1, 'amy', true], [1, 'zoe', false], [2, 'bob', false], [3, 'amy', false]],
  );
  // canonical order: effect 5 before 7, then zoe's 1, then bob's 9 wins
  assert.equal(engine.cache.get('H').score, 9);

  // shuffled input converges to identical state
  const shuffled = [...ops].reverse();
  const engine2 = new Engine();
  engine2.replay(shuffled);
  assert.deepEqual(engine2.snapshot(), engine.snapshot());
  assert.deepEqual(engine2.certificate('H'), engine.certificate('H'));
});

test('rankDiff reports only changed entries', () => {
  const before = [
    { id: 'A', score: 3, rank: 1 },
    { id: 'B', score: 2, rank: 2 },
  ];
  const after = [
    { id: 'B', score: 4, rank: 1 },
    { id: 'A', score: 3, rank: 2 },
    { id: 'C', score: 1, rank: 3 },
  ];
  assert.deepEqual(rankDiff(before, after), [
    { id: 'A', from: 1, to: 2 },
    { id: 'B', from: 2, to: 1 },
    { id: 'C', from: null, to: 3 },
  ]);
});
