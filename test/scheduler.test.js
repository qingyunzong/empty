'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { schedule, enumerateOptimal } = require('../src/scheduler');
const { mulberry32 } = require('./helpers');

test('acceptance 1: small sets (n<=9) match exhaustive enumeration for max on-time completion', () => {
  for (const seed of [42, 2026]) {
    const rand = mulberry32(seed);
    for (let trial = 0; trial < 6; trial++) {
      const n = 1 + Math.floor(rand() * 9);
      const workerCount = 1 + Math.floor(rand() * 3);
      const workers = Array.from({ length: workerCount }, (_, i) => ({
        id: 'w' + i,
        throughput: 2 + Math.floor(rand() * 9),
        maxClassification: 1 + Math.floor(rand() * 3),
      }));
      const jobs = Array.from({ length: n }, (_, i) => ({
        packId: 'p' + i,
        tenant: 't' + (i % 3),
        size: 1 + Math.floor(rand() * 6),
        classification: 1 + Math.floor(rand() * 3),
        deadline: 5 + Math.floor(rand() * 30),
        enqueuedAt: Math.floor(rand() * 4),
      }));
      const now = Math.floor(rand() * 10);
      const waitThreshold = 1 + Math.floor(rand() * 6);
      const opts = { now, waitThreshold };
      const greedy = schedule(jobs, workers, opts);
      const optimal = enumerateOptimal(jobs, workers, opts);
      assert.equal(
        greedy.assignments.length,
        optimal.maxOnTime,
        `seed=${seed} trial=${trial} n=${n}: scheduler must achieve enumeration optimum`
      );
      assert.equal(greedy.optimal, true);
      for (const a of greedy.assignments) {
        const job = jobs.find((j) => j.packId === a.packId);
        const worker = workers.find((w) => w.id === a.workerId);
        assert.ok(worker.maxClassification >= job.classification, 'classification ceiling respected');
      }
    }
  }
});

test('scheduler never exceeds worker throughput', () => {
  const workers = [{ id: 'w1', throughput: 5, maxClassification: 2 }];
  const jobs = [
    { packId: 'a', tenant: 't', size: 3, classification: 1, deadline: 1, enqueuedAt: 0 },
    { packId: 'b', tenant: 't', size: 3, classification: 1, deadline: 2, enqueuedAt: 0 },
  ];
  const r = schedule(jobs, workers, { now: 0, waitThreshold: 0 });
  assert.equal(r.assignments.length, 1);
  assert.equal(r.deferred.length, 1);
});
