import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../src/evidence.js';

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

function randomScenario(seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const nStudies = 1 + Math.floor(rand() * 10);
  const nClaims = 1 + Math.floor(rand() * 6);
  const studyIds = Array.from({ length: nStudies }, (_, i) => `s${i}`);
  const claimIds = Array.from({ length: nClaims }, (_, i) => `h${i}`);
  const ops = [];
  let seq = 0;
  const next = (authorId, op) => ({ seq: (seq += 1), authorId, ...op });

  for (const id of studyIds) {
    ops.push(next('setup', {
      type: 'add_study',
      id,
      weight: Math.floor(rand() * 5),
      effect: Math.round((rand() * 2 - 1) * 100) / 100,
    }));
  }
  for (let i = 0; i < nClaims; i += 1) {
    const nRefs = 1 + Math.floor(rand() * 3);
    const refs = new Set();
    const pool = [...studyIds, ...claimIds.slice(0, i)];
    for (let r = 0; r < nRefs; r += 1) refs.add(pick(pool));
    ops.push(next('setup', { type: 'add_claim', id: claimIds[i], op: rand() < 0.5 ? 'all' : 'any', refs: [...refs] }));
  }

  const mutations = [];
  const authors = ['amy', 'ben', 'cy'];
  for (let m = 0; m < 25; m += 1) {
    const kind = Math.floor(rand() * 6);
    if (kind === 0) {
      mutations.push(next(pick(authors), { type: 'retract_study', id: pick(studyIds) }));
    } else if (kind === 1) {
      mutations.push(next(pick(authors), { type: 'restore_study', id: pick(studyIds) }));
    } else if (kind === 2) {
      mutations.push(next(pick(authors), { type: 'set_weight', id: pick(studyIds), weight: Math.floor(rand() * 5) }));
    } else if (kind === 3) {
      mutations.push(next(pick(authors), { type: 'set_effect', id: pick(studyIds), effect: Math.round((rand() * 2 - 1) * 100) / 100 }));
    } else if (kind === 4) {
      const claim = pick(claimIds);
      const pool = [...studyIds, ...claimIds.filter((c) => c !== claim)];
      mutations.push(next(pick(authors), { type: 'add_edge', claim, ref: pick(pool) }));
    } else {
      const claim = pick(claimIds);
      const pool = [...studyIds, ...claimIds.filter((c) => c !== claim)];
      mutations.push(next(pick(authors), { type: 'remove_edge', claim, ref: pick(pool) }));
    }
  }
  return { ops, mutations, claimIds };
}

function fullRecompute(ops) {
  const graph = new EvidenceGraph();
  graph.replay(ops);
  return graph;
}

function snapshot(graph, claimIds) {
  return {
    ranking: graph.getRanking(),
    excluded: graph.getExcluded(),
    certificates: claimIds.map((id) => graph.getCertificate(id)),
  };
}

test('incremental updates match full recompute and reference sort (<=6 claims, <=10 studies)', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const { ops, mutations, claimIds } = randomScenario(seed);
    const incremental = fullRecompute(ops);
    const history = [...ops];
    for (const mutation of mutations) {
      incremental.replay([mutation]);
      history.push(mutation);
      const reference = fullRecompute(history);
      assert.deepEqual(snapshot(incremental, claimIds), snapshot(reference, claimIds), `seed=${seed} after ${JSON.stringify(mutation)}`);
    }
  }
});

test('ranking satisfies reference ordering: score desc, id asc, dense ranks', () => {
  for (let seed = 100; seed < 120; seed += 1) {
    const { ops, mutations } = randomScenario(seed);
    const graph = fullRecompute([...ops, ...mutations]);
    const ranking = graph.getRanking();
    const expected = [...ranking].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(ranking.map((r) => r.id), expected.map((r) => r.id));
    ranking.forEach((entry, i) => assert.equal(entry.rank, i + 1));
    const rankedIds = new Set(ranking.map((r) => r.id));
    for (const e of graph.getExcluded()) assert.ok(!rankedIds.has(e.id));
  }
});

test('hand-computed weighted averages match library scores', () => {
  const graph = new EvidenceGraph();
  graph.addStudy('s1', { weight: 2, effect: 0.4 });
  graph.addStudy('s2', { weight: 1, effect: 0.1 });
  graph.addStudy('s3', { weight: 3, effect: -0.2 });
  graph.addClaim('h1', { op: 'any', refs: ['s1', 's2'] });
  graph.addClaim('h2', { op: 'all', refs: ['s1', 's2', 's3'] });
  graph.addClaim('h3', { op: 'any', refs: ['h2'] });
  const ranking = graph.getRanking();
  const scoreOf = (id) => ranking.find((r) => r.id === id)?.score;
  assert.ok(Math.abs(scoreOf('h1') - (2 * 0.4 + 1 * 0.1) / 3) < 1e-12);
  assert.ok(Math.abs(scoreOf('h2') - (2 * 0.4 + 1 * 0.1 + 3 * -0.2) / 6) < 1e-12);
  assert.ok(Math.abs(scoreOf('h3') - scoreOf('h2')) < 1e-12);
  assert.deepEqual(graph.getCertificate('h1').studies, ['s1', 's2']);
});
