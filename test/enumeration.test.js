import test from 'node:test';
import assert from 'node:assert/strict';
import { planRound, buildItems, validateInput } from '../src/scheduler.js';
import { initialState } from '../src/store.js';

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

// Independent brute-force reference: recursive subset enumeration over the
// discrete items, greedy fill of splittable batches, same scoring contract
// (sum of settled weights, splittable counted pro-rata).
function bruteForce(discrete, splittable, capacity, quotas) {
  let best = { score: 0, used: 0 };
  const visit = (i, chosen) => {
    if (i === discrete.length) {
      let used = 0;
      const perInst = {};
      let weight = 0;
      for (const it of chosen) {
        used += it.amount;
        weight += it.weight;
        for (const [inst, amt] of Object.entries(it.instAmounts)) {
          perInst[inst] = (perInst[inst] ?? 0) + amt;
        }
      }
      if (used > capacity + 1e-9) return;
      for (const [inst, amt] of Object.entries(perInst)) {
        if (amt > (quotas[inst] ?? 0) + 1e-9) return;
      }
      let score = weight;
      let room = capacity - used;
      const left = { ...perInst };
      for (const s of splittable) {
        const can = Math.min(s.amount, room, (quotas[s.institution] ?? 0) - (left[s.institution] ?? 0));
        if (can > 1e-9) {
          score += s.weight * (can / s.amount);
          room -= can;
          used += can;
          left[s.institution] = (left[s.institution] ?? 0) + can;
        }
      }
      if (score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && used > best.used)) {
        best = { score, used };
      }
      return;
    }
    visit(i + 1, chosen);
    visit(i + 1, [...chosen, discrete[i]]);
  };
  visit(0, []);
  return best;
}

test('n<=9: scheduler packing matches exhaustive enumeration', () => {
  const rand = mulberry32(2024);
  let checked = 0;
  for (let iter = 0; iter < 200 && checked < 60; iter++) {
    const nInst = 1 + Math.floor(rand() * 3);
    const institutions = {};
    for (let i = 0; i < nInst; i++) institutions[`I${i}`] = { quota: 5 + Math.floor(rand() * 25) };
    const capacity = 8 + Math.floor(rand() * 25);
    const nDiscrete = 1 + Math.floor(rand() * 9);
    const batches = [];
    for (let i = 0; i < nDiscrete; i++) {
      const b = {
        id: `d${i}`,
        institution: `I${Math.floor(rand() * nInst)}`,
        amount: 1 + Math.floor(rand() * 7),
        priority: 1 + Math.floor(rand() * 9),
      };
      if (rand() < 0.35) b.group = `g${Math.floor(i / 2)}`;
      batches.push(b);
    }
    const nSplit = Math.floor(rand() * 3);
    for (let i = 0; i < nSplit; i++) {
      batches.push({
        id: `s${i}`,
        institution: `I${Math.floor(rand() * nInst)}`,
        amount: 1 + Math.floor(rand() * 20),
        priority: 1 + Math.floor(rand() * 9),
        splittable: true,
      });
    }
    const input = { capacity, agingLimit: 1, agingBonus: 1, institutions, batches };
    if (validateInput(input)) continue;
    checked++;
    const state = initialState(input);
    const { discrete, splittable } = buildItems(input, state.remaining, state.waits);
    assert.ok(discrete.length <= 9);
    const quotas = Object.fromEntries(Object.entries(institutions).map(([k, v]) => [k, v.quota]));
    const planned = planRound(input, state.remaining, state.waits);
    const ref = bruteForce(discrete, splittable, capacity, quotas);
    assert.ok(
      Math.abs(planned.score - ref.score) < 1e-6,
      `score ${planned.score} == optimal ${ref.score} (iter ${iter})`,
    );
    assert.ok(planned.used <= capacity + 1e-9, 'capacity hard limit');
    const perInst = {};
    for (const a of planned.allocations) perInst[a.institution] = (perInst[a.institution] ?? 0) + a.amount;
    for (const [inst, amt] of Object.entries(perInst)) {
      assert.ok(amt <= quotas[inst] + 1e-9, `quota hard limit for ${inst}`);
    }
    // atomic groups all-or-nothing inside the round
    const groupMembers = new Map();
    for (const b of batches) {
      if (b.group) {
        if (!groupMembers.has(b.group)) groupMembers.set(b.group, []);
        groupMembers.get(b.group).push(b.id);
      }
    }
    const settled = new Set(planned.allocations.map((a) => a.batch));
    for (const members of groupMembers.values()) {
      const inside = members.filter((m) => settled.has(m)).length;
      assert.ok(inside === 0 || inside === members.length, 'atomic all-or-nothing');
    }
  }
  assert.ok(checked >= 30, `enough valid instances checked (${checked})`);
});
