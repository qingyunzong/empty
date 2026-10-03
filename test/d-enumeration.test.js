'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib.js');

// Independent brute-force oracle, written directly from the spec:
// - effective severity = max(inherited family risk, defect severities)
// - recall rules at that severity always win
// - otherwise the rule from the latest policy version wins; ties fail safe to hold
// - no applicable rule -> hold
function oracle(policy, inheritedRisk, severities) {
  const rules = [];
  for (const v of policy.versions) {
    for (const r of v.rules) rules.push({ ...r, since: v.version });
  }
  const eff = Math.max(inheritedRisk, ...(severities.length ? severities : [0]));
  const atLevel = rules.filter((r) => r.severity === eff);
  if (atLevel.some((r) => r.action === 'recall')) return 'recall';
  const gates = atLevel.filter((r) => r.action !== 'recall');
  if (gates.length === 0) return 'hold';
  const latest = Math.max(...gates.map((r) => r.since));
  const winners = gates.filter((r) => r.since === latest).map((r) => r.action);
  if (winners.includes('hold')) return 'hold';
  return 'release';
}

const POLICY = {
  families: { f: 1 },
  versions: [
    { version: 1, rules: [
      { id: 'A', severity: 1, action: 'release' },
      { id: 'B', severity: 2, action: 'hold' },
      { id: 'C', severity: 3, action: 'release' },
    ] },
    { version: 2, rules: [
      { id: 'D', severity: 2, action: 'release' },
      { id: 'E', severity: 3, action: 'recall' },
    ] },
    { version: 3, rules: [
      { id: 'F', severity: 1, action: 'hold' },
    ] },
  ],
};

function* severityVectors(n, maxSev) {
  if (n === 0) { yield []; return; }
  for (const rest of severityVectors(n - 1, maxSev)) {
    for (let s = 1; s <= maxSev; s += 1) yield [...rest, s];
  }
}

test('D: exhaustive enumeration of defect combinations for n<=10 matches oracle', () => {
  let checked = 0;
  for (let n = 0; n <= 10; n += 1) {
    for (const inherited of [1, 2, 3]) {
      for (const severities of severityVectors(n, 3)) {
        const expected = oracle(POLICY, inherited, severities);
        const actual = lib.decide(POLICY, inherited, severities).conclusion;
        assert.equal(actual, expected,
          `mismatch at inherited=${inherited} severities=[${severities}]`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 260000, `expected full enumeration, checked ${checked}`);
});

test('D: counterexample field appears exactly when a small perturbation flips a release', () => {
  let releases = 0;
  for (let n = 0; n <= 5; n += 1) {
    for (const inherited of [1, 2, 3]) {
      for (const severities of severityVectors(n, 3)) {
        const tests = severities.map((s, i) => ({ testId: `T${i}`, defect: 'd', severity: s }));
        const decision = lib.decide(POLICY, inherited, severities);
        if (decision.conclusion !== 'release') continue;
        releases += 1;
        const cx = lib.findCounterexample(POLICY, inherited, tests);
        // Brute-force: does ANY single-defect +/-1 shift or removal flip the result?
        let flippable = false;
        for (let i = 0; i < n && !flippable; i += 1) {
          for (const next of [severities[i] - 1, severities[i] + 1]) {
            if (next < 1 || next > 3) continue;
            const perturbed = severities.map((s, j) => (j === i ? next : s));
            if (oracle(POLICY, inherited, perturbed) !== 'release') { flippable = true; break; }
          }
          const removed = severities.filter((_, j) => j !== i);
          if (oracle(POLICY, inherited, removed) !== 'release') flippable = true;
        }
        assert.equal(cx !== null, flippable,
          `counterexample mismatch at inherited=${inherited} severities=[${severities}]`);
        if (cx) assert.notEqual(cx.conclusion, 'release');
      }
    }
  }
  assert.ok(releases > 0, 'enumeration must cover release cases');
});
