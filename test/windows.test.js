'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRules, effectiveWindows, computeFee } = require('../lib/core');
const { mulberry32 } = require('./helpers');

// Independent brute-force oracle: scan every rule at an instant.
function bruteForce(rules, ts, amount) {
  const active = rules.filter((r) => r.validFrom <= ts && ts < r.validTo);
  if (active.length === 0) return { ruleId: null, rateBps: null, fee: 0 };
  const best = Math.min(...active.map((r) => r.rateBps));
  const tied = active
    .filter((r) => r.rateBps === best)
    .sort((a, b) => (a.priority - b.priority) || (a.ruleId < b.ruleId ? -1 : 1));
  const chosen = tied[0];
  return { ruleId: chosen.ruleId, rateBps: chosen.rateBps, fee: Math.floor((amount * best) / 10000) };
}

function randomRuleSet(rng, n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor(rng() * 120);
    const span = 1 + Math.floor(rng() * 60);
    events.push({
      op: 'add',
      ruleId: `r${i}`,
      validFrom: from,
      validTo: from + span,
      rateBps: 1 + Math.floor(rng() * 500),
      priority: i, // always declared so overlap is legal
    });
  }
  // randomly revoke some rules mid-flight
  for (let i = 0; i < n; i++) {
    if (rng() < 0.3) {
      const from = events[i].validFrom;
      const to = events[i].validTo;
      events.push({ op: 'revoke', ruleId: `r${i}`, at: from + Math.floor(rng() * (to - from)) });
    }
  }
  return buildRules(events);
}

test('n<=8: effective windows match brute-force fee at every sampled instant', () => {
  for (let n = 1; n <= 8; n++) {
    for (let iter = 0; iter < 60; iter++) {
      const rng = mulberry32(n * 1000 + iter);
      const rules = randomRuleSet(rng, n);
      const windows = effectiveWindows(rules);

      // windows are contiguous and cover the full rule timeline
      const bounds = rules.flatMap((r) => [r.validFrom, r.validTo]).filter((t) => t !== Infinity);
      const lo = Math.min(...bounds);
      const hi = Math.max(...bounds);
      assert.equal(windows[0].from, lo, `n=${n} iter=${iter} window start`);
      assert.equal(windows[windows.length - 1].to, hi, `n=${n} iter=${iter} window end`);
      for (let i = 1; i < windows.length; i++) {
        assert.equal(windows[i].from, windows[i - 1].to, `n=${n} iter=${iter} contiguity`);
      }

      // sample every window at several instants and compare against the oracle
      for (const w of windows) {
        const samples = [w.from, (w.from + w.to) / 2, w.to - 1e-9];
        for (const ts of samples) {
          const expected = bruteForce(rules, ts, 12345);
          const viaWindows = { ruleId: w.ruleId, rateBps: w.rateBps };
          assert.deepEqual(
            viaWindows,
            { ruleId: expected.ruleId, rateBps: expected.rateBps },
            `n=${n} iter=${iter} ts=${ts}`,
          );
          const feeEntry = computeFee(rules, { txId: 'x', ts, amount: 12345 });
          assert.equal(feeEntry.fee, expected.fee, `fee n=${n} iter=${iter} ts=${ts}`);
          assert.equal(feeEntry.ruleId, expected.ruleId, `ruleId n=${n} iter=${iter} ts=${ts}`);
        }
      }
    }
  }
});

test('windows report all tied best-rate rules', () => {
  const rules = buildRules([
    { op: 'add', ruleId: 'a', validFrom: 0, validTo: 100, rateBps: 10, priority: 2 },
    { op: 'add', ruleId: 'b', validFrom: 50, validTo: 150, rateBps: 10, priority: 1 },
    { op: 'add', ruleId: 'c', validFrom: 0, validTo: 200, rateBps: 99, priority: 3 },
  ]);
  const windows = effectiveWindows(rules);
  const overlap = windows.find((w) => w.from === 50 && w.to === 100);
  assert.deepEqual(overlap.tied, ['a', 'b']);
  assert.equal(overlap.ruleId, 'b'); // priority 1 wins
});
