'use strict';

// Cross-checks the engine against an independent reference that expands
// stock into individual units, enumerates every feasible matching between
// units and order lines, and picks the optimum under the documented
// objective: lexicographic over lines in reservation order of
// (fill count desc, sorted (expiry, batchId) vector asc).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, allocate } = require('../index');

function cmpValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function refClosure(edges, material) {
  const seen = new Set([material]);
  const stack = [material];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const [from, to] of edges) {
      if (from === cur && !seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}

function referenceAllocate(state) {
  const now = state.now ?? null;
  const units = [];
  for (const batch of state.batches) {
    if (batch.status !== 'OK') continue;
    if (now !== null && batch.expiry < now) continue;
    for (let i = 0; i < batch.qty; i++) {
      units.push({ batchId: batch.id, material: batch.material, expiry: batch.expiry });
    }
  }

  const orders = [...state.orders].sort((a, b) => cmpValue(a.due, b.due) || cmpValue(a.id, b.id));
  const lines = [];
  for (const order of orders) {
    for (const line of [...order.lines].sort((a, b) => cmpValue(a.line, b.line))) {
      lines.push({ orderId: order.id, line: line.line, material: line.material, need: line.qty });
    }
  }

  const cmpUnit = (u, v) => cmpValue(u.expiry, v.expiry) || cmpValue(u.batchId, v.batchId);
  const assignment = lines.map(() => []);
  const used = new Array(units.length).fill(false);
  let best = null;

  const isBetter = (a, b) => {
    for (let i = 0; i < lines.length; i++) {
      if (a[i].length !== b[i].length) return a[i].length > b[i].length;
      const ka = a[i].map((u) => units[u]).sort(cmpUnit);
      const kb = b[i].map((u) => units[u]).sort(cmpUnit);
      for (let j = 0; j < ka.length; j++) {
        const c = cmpUnit(ka[j], kb[j]);
        if (c !== 0) return c < 0;
      }
    }
    return false;
  };

  function search(lineIndex) {
    if (lineIndex === lines.length) {
      if (best === null || isBetter(assignment, best)) {
        best = assignment.map((chosen) => [...chosen]);
      }
      return;
    }
    const line = lines[lineIndex];
    const materials = refClosure(state.substitutes, line.material);
    // Group remaining eligible units by batch; units within a batch are
    // identical, so choosing "t units of this batch" covers every
    // distinct matching exactly once.
    const groups = new Map();
    units.forEach((unit, index) => {
      if (used[index] || !materials.has(unit.material)) return;
      if (!groups.has(unit.batchId)) groups.set(unit.batchId, []);
      groups.get(unit.batchId).push(index);
    });
    const groupList = [...groups.values()];
    const chosen = [];
    function pick(groupIndex, needLeft) {
      if (groupIndex === groupList.length || needLeft === 0) {
        for (const index of chosen) used[index] = true;
        assignment[lineIndex] = [...chosen];
        search(lineIndex + 1);
        for (const index of chosen) used[index] = false;
        return;
      }
      const group = groupList[groupIndex];
      for (let take = 0; take <= Math.min(needLeft, group.length); take++) {
        for (let k = 0; k < take; k++) chosen.push(group[k]);
        pick(groupIndex + 1, needLeft - take);
        for (let k = 0; k < take; k++) chosen.pop();
      }
    }
    pick(0, line.need);
  }

  search(0);

  const reservations = [];
  best.forEach((unitIndexes, lineIndex) => {
    const perBatch = new Map();
    for (const index of unitIndexes) {
      const unit = units[index];
      perBatch.set(unit.batchId, (perBatch.get(unit.batchId) ?? 0) + 1);
    }
    for (const [batchId, qty] of perBatch) {
      reservations.push({
        orderId: lines[lineIndex].orderId,
        line: lines[lineIndex].line,
        batchId,
        qty,
      });
    }
  });
  return reservations;
}

function normalized(reservations) {
  return reservations
    .map((r) => ({ orderId: r.orderId, line: r.line, batchId: r.batchId, qty: r.qty }))
    .sort(
      (a, b) =>
        cmpValue(a.orderId, b.orderId) ||
        cmpValue(a.line, b.line) ||
        cmpValue(a.batchId, b.batchId)
    );
}

function assertMatchesReference(input) {
  const state = createState(input);
  const engineResult = allocate(state);
  const referenceResult = referenceAllocate(state);
  assert.deepEqual(normalized(engineResult.reservations), normalized(referenceResult));
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(rand) {
  const materials = ['M1', 'M2', 'M3'];
  const substitutes = [];
  for (let i = 0; i < materials.length; i++) {
    for (let j = i + 1; j < materials.length; j++) {
      if (rand() < 0.35) substitutes.push([materials[i], materials[j]]); // acyclic by construction
    }
  }
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const batches = [];
  const batchCount = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < batchCount; k++) {
    batches.push({
      id: `B${k}`,
      material: pick(materials),
      qty: Math.floor(rand() * 3), // 0..2
      expiry: `2026-0${1 + Math.floor(rand() * 4)}-15`,
      status: rand() < 0.8 ? 'OK' : 'HOLD',
    });
  }
  const orders = [];
  const orderCount = 1 + Math.floor(rand() * 2);
  for (let k = 0; k < orderCount; k++) {
    const lineCount = 1 + Math.floor(rand() * 2);
    const lines = [];
    for (let n = 0; n < lineCount; n++) {
      lines.push({ line: n + 1, material: pick(materials), qty: 1 + Math.floor(rand() * 3) });
    }
    orders.push({ id: `O${k}`, due: `2026-01-${10 + Math.floor(rand() * 3) * 5}`, lines });
  }
  const input = { batches, substitutes, orders };
  if (rand() < 0.3) input.now = '2026-02-20';
  return input;
}

test('directed case: engine matches brute-force reference', () => {
  assertMatchesReference({
    substitutes: [['M1', 'M2']],
    batches: [
      { id: 'B1', material: 'M1', qty: 2, expiry: '2026-02-01', status: 'OK' },
      { id: 'B2', material: 'M2', qty: 3, expiry: '2026-01-15', status: 'OK' },
      { id: 'B3', material: 'M1', qty: 2, expiry: '2026-03-01', status: 'OK' },
    ],
    orders: [
      { id: 'O1', due: '2026-01-10', lines: [{ line: 1, material: 'M1', qty: 3 }] },
      { id: 'O2', due: '2026-01-11', lines: [{ line: 1, material: 'M2', qty: 2 }] },
    ],
  });
});

test('seeded randomized cases: engine matches brute-force reference', () => {
  const rand = mulberry32(20261003);
  for (let i = 0; i < 150; i++) {
    const input = randomCase(rand);
    try {
      assertMatchesReference(input);
    } catch (err) {
      err.message = `case ${i}: ${err.message}\ninput: ${JSON.stringify(input)}`;
      throw err;
    }
  }
});
