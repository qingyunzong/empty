'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solvePlacement, enumeratePlacements } = require('../lib/solver');

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

const TYPES = ['trade', 'fee', 'freeze', 'settle'];

function randomCase(rand) {
  const stageCount = 1 + Math.floor(rand() * 4); // <= 4 stages
  const stages = [];
  for (let i = 0; i < stageCount; i += 1) {
    const dependsOn = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < 0.4) dependsOn.push(`s${j}`);
    }
    stages.push({
      id: `s${i}`,
      type: TYPES[Math.floor(rand() * TYPES.length)],
      account: rand() < 0.7 ? 'A' : 'B',
      amount: 10 + Math.floor(rand() * 5) * 10,
      dependsOn,
      children: [],
    });
  }
  for (const stage of stages) {
    for (const parentId of stage.dependsOn) {
      stages[Number(parentId.slice(1))].children.push(stage.id);
    }
  }
  const batchCount = 1 + Math.floor(rand() * 3);
  const batches = [];
  for (let i = 0; i < batchCount; i += 1) {
    const domains = new Set(TYPES.filter(() => rand() < 0.7));
    if (domains.size === 0) domains.add('trade');
    batches.push({
      id: `b${i}`,
      domains,
      quotas: new Map([
        ['A', Math.floor(rand() * 13) * 10],
        ['B', Math.floor(rand() * 13) * 10],
      ]),
    });
  }
  const remaining = new Map(batches.map((b) => [b.id, new Map(b.quotas)]));
  return { stages, batches, remaining };
}

test('solver matches brute-force enumeration for <= 4 stages', () => {
  const rand = mulberry32(20261003);
  for (let trial = 0; trial < 300; trial += 1) {
    const { stages, batches, remaining } = randomCase(rand);
    const compensated = new Set();
    // randomCase builds parents before children; solver consumes children-first.
    const ordered = [...stages].reverse();
    const solved = solvePlacement(ordered, batches, remaining, compensated);
    const reference = enumeratePlacements(ordered, batches, remaining, compensated);
    assert.equal(
      solved.count,
      reference,
      `trial ${trial}: solver=${solved.count} reference=${reference}`
    );

    // Verify the solver's own assignment is feasible.
    const used = new Map(batches.map((b) => [b.id, new Map()]));
    for (const stage of ordered) {
      const batchId = solved.placements.get(stage.id);
      if (batchId === undefined) continue;
      const batch = batches.find((b) => b.id === batchId);
      assert.ok(batch.domains.has(stage.type), 'domain respected');
      for (const childId of stage.children) {
        assert.ok(solved.placements.has(childId), 'children placed first');
      }
      const acc = used.get(batchId);
      acc.set(stage.account, (acc.get(stage.account) || 0) + stage.amount);
    }
    for (const [batchId, accounts] of used) {
      for (const [account, total] of accounts) {
        assert.ok(
          total <= (remaining.get(batchId).get(account) || 0),
          'quota respected'
        );
      }
    }
  }
});

test('enumeration sanity: single stage, single fitting batch', () => {
  const stages = [
    { id: 's0', type: 'trade', account: 'A', amount: 50, dependsOn: [], children: [] },
  ];
  const batches = [{ id: 'b0', domains: new Set(['trade']), quotas: new Map([['A', 50]]) }];
  const remaining = new Map([['b0', new Map([['A', 50]])]]);
  assert.equal(enumeratePlacements(stages, batches, remaining, new Set()), 1);
  remaining.get('b0').set('A', 49);
  assert.equal(enumeratePlacements(stages, batches, remaining, new Set()), 0);
});
