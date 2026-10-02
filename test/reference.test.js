'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { award, applyChange } = require('../src/lib');
const { referenceAward } = require('../src/reference');

// Deterministic PRNG (mulberry32) so the fuzz run is reproducible.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand) {
  const processPool = ['P1', 'P2', 'P3', 'P4', 'P5'];
  const machineCount = 1 + Math.floor(rand() * 12); // 1..12 machines
  const machineIds = Array.from({ length: machineCount }, (_, i) => `M${i + 1}`);

  const reqCount = 1 + Math.floor(rand() * 4);
  const required = [...processPool].sort(() => rand() - 0.5).slice(0, reqCount);
  const orders = required.map((p) => ({ order: 'O1', process: p }));

  const machines = [];
  const costs = [];
  for (const id of machineIds) {
    const procCount = 1 + Math.floor(rand() * 3);
    const procs = [...processPool].sort(() => rand() - 0.5).slice(0, procCount);
    for (const p of procs) {
      // ~25% of certificates are null (invalid)
      const expiry = rand() < 0.25 ? null : '2027-01-01';
      machines.push({ machine: id, process: p, cert_expiry: expiry });
    }
    costs.push({ machine: id, shift_cost: 1 + Math.floor(rand() * 20) });
  }
  const budget = Math.floor(rand() * 60);
  return { orders, machines, costs, budget };
}

function normalize(result) {
  if (result.status === 'awarded') {
    return { status: 'awarded', machines: result.machines, total_cost: result.total_cost };
  }
  return { status: 'infeasible', certificate: result.certificate };
}

test('reference cross-check: 300 random instances, <= 12 machines each', () => {
  const rand = rng(20261002);
  for (let i = 0; i < 300; i += 1) {
    const data = randomInstance(rand);
    const actual = award(data, 'O1');
    const expected = referenceAward(data, 'O1');
    assert.deepEqual(normalize(actual), normalize(expected), `instance ${i}: ${JSON.stringify(data)}`);
  }
});

test('reference cross-check: incremental events stay consistent', () => {
  const rand = rng(42);
  for (let i = 0; i < 100; i += 1) {
    const data = randomInstance(rand);
    const machineIds = [...new Set(data.machines.map((m) => m.machine))];
    const events = [];
    if (rand() < 0.5 && machineIds.length > 0) {
      events.push({ type: 'revoke-cert', machine: machineIds[Math.floor(rand() * machineIds.length)] });
    }
    if (rand() < 0.5) {
      events.push({ type: 'budget', budget: Math.floor(rand() * 40) });
    }
    if (events.length === 0) continue;
    const result = applyChange(data, 'O1', events);

    // Independently apply the events and re-check with the reference.
    let changed = data;
    for (const e of events) {
      if (e.type === 'revoke-cert') {
        changed = {
          ...changed,
          machines: changed.machines.map((row) =>
            row.machine === e.machine && (e.process === undefined || row.process === e.process)
              ? { ...row, cert_expiry: null }
              : row),
        };
      } else {
        changed = { ...changed, budget: e.budget };
      }
    }
    const expected = referenceAward(changed, 'O1');
    assert.deepEqual(
      normalize(result.reassignment),
      normalize(expected),
      `instance ${i}: ${JSON.stringify({ data, events })}`,
    );

    // Diff must be consistent with the withdrawn and reassigned sets.
    const oldSet = result.withdrawn.machines;
    const newSet = result.reassignment.status === 'awarded' ? result.reassignment.machines : [];
    for (const m of result.diff.removed) assert.ok(oldSet.includes(m) && !newSet.includes(m));
    for (const m of result.diff.added) assert.ok(!oldSet.includes(m) && newSet.includes(m));
  }
});
