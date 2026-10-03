// Acceptance 1: cross-check the solver against a brute-force oracle that
// enumerates every legal parent subset and quantity combination.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModel } from '../src/model.js';
import { solve } from '../src/solver.js';

// Independent brute-force enumerator: counts all valid full assignments.
function bruteForceCount(model) {
  const { batches, order } = model;
  const availOf = (id) => (batches.get(id).kind === 'material' ? batches.get(id).quantity : batches.get(id).outputQty);

  const byLine = new Map();
  for (const pid of order) {
    const p = batches.get(pid);
    const list = byLine.get(p.line) ?? [];
    for (const q of list) {
      if (p.start <= q.end && q.start <= p.end) return 0; // line overlap
    }
    list.push(p);
    byLine.set(p.line, list);
  }

  const quarantined = new Set();
  for (const [id, b] of batches) if (b.status === 'quarantined') quarantined.add(id);

  const resid = new Map([...batches.keys()].map((id) => [id, availOf(id)]));
  let count = 0;

  function rec(pos) {
    if (pos === order.length) {
      count++;
      return;
    }
    const p = batches.get(order[pos]);
    const need = p.outputQty + p.loss;
    const cands = p.candidates;
    const caps = cands.map((c) => Math.min(availOf(c), need, resid.get(c)));
    const qty = new Array(cands.length).fill(0);

    function gen(j, rest) {
      if (j === cands.length) {
        if (rest !== 0) return;
        for (let k = 0; k < cands.length; k++) {
          if (qty[k] === 0) continue;
          const c = cands[k];
          if (quarantined.has(c)) return; // no direct/indirect quarantine
          if (!(p.expiry <= batches.get(c).expiry)) return; // expiry order
        }
        for (let k = 0; k < cands.length; k++) resid.set(cands[k], resid.get(cands[k]) - qty[k]);
        rec(pos + 1);
        for (let k = 0; k < cands.length; k++) resid.set(cands[k], resid.get(cands[k]) + qty[k]);
        return;
      }
      for (let q = 0; q <= Math.min(caps[j], rest); q++) {
        qty[j] = q;
        gen(j + 1, rest - q);
      }
    }
    gen(0, need);
  }
  rec(0);
  return count;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const EXPIRIES = ['2026-01-01', '2026-02-01', '2026-03-01'];
const WINDOWS = [
  ['2026-01-05', '2026-01-08'],
  ['2026-01-07', '2026-01-10'],
  ['2026-01-12', '2026-01-15'],
];

function genInstance(rand) {
  const batches = [];
  const nM = 1 + Math.floor(rand() * 3); // 1..3 materials
  for (let i = 0; i < nM; i++) {
    batches.push({
      id: `M${i}`,
      kind: 'material',
      quantity: Math.floor(rand() * 7), // 0..6
      expiry: EXPIRIES[Math.floor(rand() * EXPIRIES.length)],
      status: rand() < 0.2 ? 'quarantined' : 'released',
    });
  }
  const nP = 1 + Math.floor(rand() * 2); // 1..2 production batches
  const ids = batches.map((b) => b.id);
  for (let i = 0; i < nP; i++) {
    const candidates = ids.filter(() => rand() < 0.6);
    const w = WINDOWS[Math.floor(rand() * WINDOWS.length)];
    batches.push({
      id: `P${i}`,
      kind: 'production',
      line: `L${Math.floor(rand() * 2)}`,
      start: w[0],
      end: w[1],
      outputQty: 1 + Math.floor(rand() * 3), // 1..3
      loss: Math.floor(rand() * 2), // 0..1
      expiry: EXPIRIES[Math.floor(rand() * EXPIRIES.length)],
      candidates,
    });
    ids.push(`P${i}`);
  }
  return { budget: 1000000, batches };
}

test('solver matches brute-force oracle on random small instances', () => {
  let feasible = 0;
  let infeasible = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const input = genInstance(lcg(seed));
    const model = parseModel(input);
    const expected = bruteForceCount(model);
    const result = solve(model, { solutionCap: Infinity, budget: 1000000 });
    assert.equal(
      result.solutionCount,
      expected,
      `seed ${seed}: solver=${result.solutionCount} oracle=${expected}\n${JSON.stringify(input)}`,
    );
    assert.equal(result.status, expected > 0 ? 'feasible' : 'infeasible', `seed ${seed}`);
    if (expected > 0) feasible++;
    else infeasible++;
  }
  assert.ok(feasible > 50, `want a decent feasible sample, got ${feasible}`);
  assert.ok(infeasible > 50, `want a decent infeasible sample, got ${infeasible}`);
});

test('solver solutions satisfy all constraints (validity spot check)', () => {
  for (let seed = 1000; seed < 1050; seed++) {
    const input = genInstance(lcg(seed));
    const model = parseModel(input);
    const result = solve(model, { budget: 1000000 });
    if (result.status !== 'feasible') continue;
    const used = new Map();
    for (const e of result.edges) {
      const parent = model.batches.get(e.parent);
      const child = model.batches.get(e.child);
      assert.notEqual(parent.status, 'quarantined');
      assert.ok(child.expiry <= parent.expiry, 'expiry order');
      assert.ok(child.candidates.includes(e.parent), 'edge from candidate set');
      used.set(e.parent, (used.get(e.parent) ?? 0) + e.quantity);
    }
    for (const pid of model.order) {
      const p = model.batches.get(pid);
      const sum = result.edges.filter((e) => e.child === pid).reduce((s, e) => s + e.quantity, 0);
      assert.equal(sum, p.outputQty + p.loss, `input-sum for ${pid}`);
    }
    for (const [id, qty] of used) {
      const b = model.batches.get(id);
      const avail = b.kind === 'material' ? b.quantity : b.outputQty;
      assert.ok(qty <= avail, `availability of ${id}`);
    }
  }
});
