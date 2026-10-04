import test from 'node:test';
import assert from 'node:assert/strict';
import { KittingEngine } from '../src/engine.js';

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Independent reference: enumerate every capacity-respecting assignment of
// stock to lines, then pick the lexicographic optimum under the shared
// objective (lines in reservation order; batches in expiresAt/batchId order;
// more quantity in earlier positions is better).
function referenceAllocate(input) {
  const substitutions = new Map();
  for (const { material, substitute } of input.substitutions ?? []) {
    if (!substitutions.has(material)) substitutions.set(material, new Set());
    substitutions.get(material).add(substitute);
  }
  const reachable = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const next of substitutions.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };

  const batches = (input.batches ?? [])
    .filter((batch) => (batch.status ?? 'OK') === 'OK')
    .slice()
    .sort((a, b) => compareStrings(a.expiresAt, b.expiresAt) || compareStrings(a.batchId, b.batchId));

  const lines = [];
  const orders = (input.orders ?? [])
    .slice()
    .sort((a, b) => compareStrings(a.dueDate, b.dueDate) || compareStrings(a.orderId, b.orderId));
  for (const order of orders) {
    order.lines.forEach((line, index) => {
      lines.push({
        orderId: order.orderId,
        lineId: line.lineId ?? `L${index + 1}`,
        materialId: line.materialId,
        qty: line.qty,
      });
    });
  }

  const candidateIndexes = lines.map((line) => {
    const served = reachable(line.materialId);
    return batches.map((batch, i) => i).filter((i) => served.has(batches[i].materialId));
  });

  const allocation = lines.map(() => new Array(batches.length).fill(0));
  const remaining = batches.map((batch) => batch.qty);
  let best = null;

  const isBetter = (candidate, incumbent) => {
    for (let li = 0; li < lines.length; li += 1) {
      for (let bi = 0; bi < batches.length; bi += 1) {
        if (candidate[li][bi] !== incumbent[li][bi]) {
          return candidate[li][bi] > incumbent[li][bi];
        }
      }
    }
    return false;
  };

  const enumerateLine = (li) => {
    if (li === lines.length) {
      if (best === null || isBetter(allocation, best)) {
        best = allocation.map((vector) => vector.slice());
      }
      return;
    }
    const candidates = candidateIndexes[li];
    const vector = allocation[li];
    const enumerateBatch = (ci, needLeft) => {
      if (ci === candidates.length) {
        enumerateLine(li + 1);
        return;
      }
      const bi = candidates[ci];
      const max = Math.min(needLeft, remaining[bi]);
      for (let qty = max; qty >= 0; qty -= 1) {
        vector[bi] = qty;
        remaining[bi] -= qty;
        enumerateBatch(ci + 1, needLeft - qty);
        remaining[bi] += qty;
      }
      vector[bi] = 0;
    };
    enumerateBatch(0, lines[li].qty);
  };
  enumerateLine(0);

  const result = new Map();
  lines.forEach((line, li) => {
    const perBatch = {};
    batches.forEach((batch, bi) => {
      if (best[li][bi] > 0) perBatch[batch.batchId] = best[li][bi];
    });
    result.set(`${line.orderId}/${line.lineId}`, perBatch);
  });
  return result;
}

function engineAllocation(input) {
  const engine = new KittingEngine(input);
  const result = new Map();
  for (const order of engine.report().orders) {
    for (const line of order.lines) {
      const perBatch = {};
      for (const reservation of line.reservations) {
        perBatch[reservation.batchId] = reservation.qty;
      }
      result.set(`${order.orderId}/${line.lineId}`, perBatch);
    }
  }
  return result;
}

function assertEngineMatchesReference(input) {
  const expected = referenceAllocate(input);
  const actual = engineAllocation(input);
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [key, perBatch] of expected) {
    assert.deepEqual(actual.get(key), perBatch, `allocation mismatch for ${key}`);
  }
}

test('engine matches brute-force reference on a crafted substitution scenario', () => {
  assertEngineMatchesReference({
    batches: [
      { batchId: 'B1', materialId: 'A', qty: 2, expiresAt: '2026-01-05' },
      { batchId: 'B2', materialId: 'B', qty: 3, expiresAt: '2026-01-01' },
      { batchId: 'B3', materialId: 'C', qty: 2, expiresAt: '2026-01-03' },
      { batchId: 'B4', materialId: 'A', qty: 1, expiresAt: '2026-01-02', status: 'HOLD' },
    ],
    substitutions: [
      { material: 'A', substitute: 'B' },
      { material: 'B', substitute: 'C' },
    ],
    orders: [
      {
        orderId: 'O1',
        dueDate: '2026-02-01',
        lines: [
          { materialId: 'A', qty: 3 },
          { materialId: 'C', qty: 1 },
        ],
      },
      { orderId: 'O2', dueDate: '2026-02-02', lines: [{ materialId: 'B', qty: 2 }] },
    ],
  });
});

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScenario(rand) {
  const materials = ['M0', 'M1', 'M2', 'M3'];
  const substitutions = [];
  for (let from = 0; from < materials.length; from += 1) {
    for (let to = from + 1; to < materials.length; to += 1) {
      if (rand() < 0.3) {
        substitutions.push({ material: materials[from], substitute: materials[to] });
      }
    }
  }
  const expiries = ['2026-01-01', '2026-01-02', '2026-01-03'];
  const batches = [];
  const batchCount = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < batchCount; i += 1) {
    batches.push({
      batchId: `B${i}`,
      materialId: materials[Math.floor(rand() * materials.length)],
      qty: Math.floor(rand() * 4),
      expiresAt: expiries[Math.floor(rand() * expiries.length)],
      status: rand() < 0.2 ? 'HOLD' : 'OK',
    });
  }
  const orders = [];
  const orderCount = 1 + Math.floor(rand() * 2);
  for (let o = 0; o < orderCount; o += 1) {
    const lineCount = 1 + Math.floor(rand() * 2);
    const lines = [];
    for (let l = 0; l < lineCount; l += 1) {
      lines.push({
        materialId: materials[Math.floor(rand() * materials.length)],
        qty: 1 + Math.floor(rand() * 3),
      });
    }
    orders.push({ orderId: `O${o}`, dueDate: `2026-02-0${o + 1}`, lines });
  }
  return { batches, substitutions, orders };
}

test('engine matches brute-force reference on seeded randomized scenarios', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const scenario = randomScenario(mulberry32(seed));
    assertEngineMatchesReference(scenario);
  }
});
