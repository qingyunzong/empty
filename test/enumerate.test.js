import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleStore, computeFee } from '../lib/rules.js';
import { rng } from './helpers.js';

// Acceptance 3: for n <= 8 rules, enumerate every atomic effective window and
// cross-check the engine's resolution against an independent brute-force scan.

// Independent reference implementation: at time t, scan all rules linearly.
function bruteForce(rules, t) {
  const active = rules.filter((r) => {
    const end = [r.validTo, r.revokedAt].filter((x) => x !== null && x !== undefined);
    const to = end.length ? Math.min(...end) : Infinity;
    return r.validFrom <= t && t < to;
  });
  if (active.length === 0) return { rateBps: 0, ruleId: null };
  const best = Math.min(...active.map((r) => r.rateBps));
  const tied = active
    .filter((r) => r.rateBps === best)
    .sort((a, b) => (b.priority ?? -Infinity) - (a.priority ?? -Infinity) || (a.ruleId < b.ruleId ? -1 : 1));
  return { rateBps: best, ruleId: tied[0].ruleId };
}

test('n<=8 rules: engine matches brute force on every enumerated window', () => {
  const random = rng(20261004);
  for (let trial = 0; trial < 200; trial++) {
    const n = 2 + Math.floor(random() * 7); // 2..8 rules
    const rules = [];
    const ops = [];
    const bounds = new Set();
    for (let i = 0; i < n; i++) {
      const validFrom = Math.floor(random() * 10_000);
      const open = random() < 0.3;
      const validTo = open ? null : validFrom + 1 + Math.floor(random() * 10_000);
      const rule = {
        ruleId: `r${i}`,
        validFrom,
        validTo,
        revokedAt: null,
        rateBps: [50, 100, 100, 250, 500][Math.floor(random() * 5)], // force ties
        priority: Math.floor(random() * 4),
      };
      rules.push(rule);
      ops.push({ op: 'add', ...rule });
      bounds.add(validFrom);
      if (validTo !== null) bounds.add(validTo);
      if (random() < 0.4) {
        const at = validFrom + Math.floor(random() * 15_000);
        rule.revokedAt = at;
        ops.push({ op: 'revoke', ruleId: rule.ruleId, at });
        bounds.add(at);
      }
    }
    const store = new RuleStore();
    ops.forEach((op, i) => store.apply(op, i + 1));

    // Sample every atomic window: boundaries, midpoints, and just-before-end.
    const sorted = [...bounds].sort((a, b) => a - b);
    const samples = new Set([0, 20_000]);
    for (let i = 0; i < sorted.length; i++) {
      samples.add(sorted[i]);
      samples.add(sorted[i] - 1);
      if (i + 1 < sorted.length) samples.add(Math.floor((sorted[i] + sorted[i + 1]) / 2));
    }
    for (const t of samples) {
      const expected = bruteForce(rules, t);
      const got = store.resolve(t);
      assert.equal(got.bestRateBps, expected.rateBps, `trial ${trial} t=${t} rate`);
      assert.equal(got.selected?.ruleId ?? null, expected.ruleId, `trial ${trial} t=${t} rule`);
      // Fee must agree too, for a spread of amounts.
      for (const amount of [0, 1, 999, 12_345_678]) {
        assert.equal(computeFee(amount, got.bestRateBps), computeFee(amount, expected.rateBps));
      }
    }
  }
});
