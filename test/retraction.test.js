import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../src/evidence.js';

function buildGraph() {
  const graph = new EvidenceGraph();
  graph.addStudy('s1', { weight: 2, effect: 0.4 });
  graph.addStudy('s2', { weight: 1, effect: 0.1 });
  graph.addStudy('s3', { weight: 3, effect: 0.9 });
  graph.addStudy('s4', { weight: 2, effect: 0.6 });
  graph.addStudy('s5', { weight: 4, effect: 0.45 });
  graph.addClaim('h1', { op: 'any', refs: ['s1', 's2'] }); // 0.3
  graph.addClaim('h2', { op: 'all', refs: ['s3'] }); // 0.9
  graph.addClaim('h3', { op: 'any', refs: ['s1', 's4'] }); // 0.5
  graph.addClaim('h10', { op: 'any', refs: ['s5'] }); // 0.45
  graph.addClaim('h9', { op: 'any', refs: ['s4'] }); // 0.6
  return graph;
}

test('retracting a key study yields a minimal ranking diff', () => {
  const graph = buildGraph();
  const before = graph.getRanking();
  assert.deepEqual(before.map((r) => r.id), ['h2', 'h9', 'h3', 'h10', 'h1']);

  const { affected, rankingDiff } = graph.retractStudy('s3');

  assert.deepEqual(affected, ['h2']);
  assert.deepEqual(rankingDiff, [
    { id: 'h1', from: 5, to: 4 },
    { id: 'h10', from: 4, to: 3 },
    { id: 'h2', from: 1, to: null },
    { id: 'h3', from: 3, to: 2 },
    { id: 'h9', from: 2, to: 1 },
  ]);
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h9', 'h3', 'h10', 'h1']);
  assert.deepEqual(graph.getExcluded(), [{ id: 'h2', status: 'excluded', reason: 'no_valid_studies' }]);

  const restore = graph.restoreStudy('s3');
  assert.deepEqual(graph.getRanking().map((r) => r.id), before.map((r) => r.id));
  assert.equal(restore.rankingDiff.length, 5);
});

test('unaffected hypotheses never appear in the diff', () => {
  const graph = buildGraph();
  const { affected, rankingDiff } = graph.setEffect('s2', 0.8);
  assert.deepEqual(affected, ['h1']);
  assert.deepEqual(rankingDiff, [
    { id: 'h1', from: 5, to: 3 },
    { id: 'h10', from: 4, to: 5 },
    { id: 'h3', from: 3, to: 4 },
  ]);
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h2', 'h9', 'h1', 'h3', 'h10']);
});

test('ties are broken by ascending hypothesis id and stay stable across updates', () => {
  const graph = new EvidenceGraph();
  graph.addStudy('s1', { weight: 1, effect: 0.5 });
  graph.addStudy('s2', { weight: 2, effect: 0.5 });
  graph.addStudy('s3', { weight: 3, effect: 0.5 });
  graph.addClaim('h2', { op: 'any', refs: ['s1'] });
  graph.addClaim('h10', { op: 'any', refs: ['s2'] });
  graph.addClaim('h1', { op: 'any', refs: ['s3'] });
  // all scores are 0.5; string-ascending id order wins: h1 < h10 < h2
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h1', 'h10', 'h2']);

  graph.setWeight('s1', 9); // score unchanged (still 0.5), no diff expected
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h1', 'h10', 'h2']);

  graph.setEffect('s3', 0.7); // h1 pulls ahead
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h1', 'h10', 'h2']);
  graph.retractStudy('s3'); // h1 excluded, remaining tie keeps id order
  assert.deepEqual(graph.getRanking().map((r) => r.id), ['h10', 'h2']);
});

test('weight correction propagates through claim-to-claim references', () => {
  const graph = new EvidenceGraph();
  graph.addStudy('s1', { weight: 1, effect: 0.2 });
  graph.addStudy('s2', { weight: 1, effect: 0.8 });
  graph.addClaim('h1', { op: 'any', refs: ['s1'] });
  graph.addClaim('h2', { op: 'any', refs: ['h1', 's2'] });
  graph.addClaim('h3', { op: 'all', refs: ['h2'] });
  const { affected } = graph.setWeight('s1', 3);
  assert.deepEqual(affected, ['h1', 'h2', 'h3']);
  const scoreOf = (id) => graph.getRanking().find((r) => r.id === id)?.score;
  assert.ok(Math.abs(scoreOf('h2') - (3 * 0.2 + 1 * 0.8) / 4) < 1e-12);
  assert.equal(scoreOf('h3'), scoreOf('h2'));
});
