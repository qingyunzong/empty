'use strict';

// Acceptance 1: for n <= 9 unit-duration cases, the scheduler's on-time
// high-risk coverage equals the brute-force optimum.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

const THRESHOLD = 70;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exact optimum over all case -> (reviewer, slot) matchings, unit durations.
function bruteForceMaxHighRisk(cases, reviewers, now) {
  const rids = Object.keys(reviewers).sort();
  const unavail = {};
  for (const rid of rids) {
    unavail[rid] = new Set();
    for (const [s, e] of reviewers[rid].unavailable || []) {
      for (let t = s; t < e; t++) unavail[rid].add(t);
    }
  }
  const memo = new Map();
  function dfs(i, occ) {
    if (i === cases.length) return 0;
    const key = i + '|' + rids.map((r) => [...occ[r]].sort((x, y) => x - y).join(',')).join('|');
    if (memo.has(key)) return memo.get(key);
    const c = cases[i];
    let best = dfs(i + 1, occ); // leave unscheduled
    const gain = c.risk >= THRESHOLD ? 1 : 0;
    for (const rid of rids) {
      if (!reviewers[rid].skills.includes(c.skill)) continue;
      for (let s = now; s < c.deadline; s++) {
        if (occ[rid].has(s) || unavail[rid].has(s)) continue;
        occ[rid].add(s);
        best = Math.max(best, dfs(i + 1, occ) + gain);
        occ[rid].delete(s);
      }
    }
    memo.set(key, best);
    return best;
  }
  return dfs(0, Object.fromEntries(rids.map((r) => [r, new Set()])));
}

test('scheduler matches brute-force max on-time high-risk coverage (n<=9)', () => {
  const rnd = mulberry32(20261003);
  for (let iter = 0; iter < 40; iter++) {
    const n = 3 + Math.floor(rnd() * 7); // 3..9 cases
    const nRev = 1 + Math.floor(rnd() * 2); // 1..2 reviewers
    const state = core.createState({ deptQuota: 1, agingRate: 0 });
    const skills = ['mol', 'ihc'];
    const reviewers = {};
    for (let r = 0; r < nRev; r++) {
      const id = `R${r}`;
      const rSkills = skills.filter(() => rnd() < 0.7);
      if (rSkills.length === 0) rSkills.push(skills[r % 2]);
      const unavailable = [];
      if (rnd() < 0.5) {
        const s = Math.floor(rnd() * 4);
        unavailable.push([s, s + 1 + Math.floor(rnd() * 2)]);
      }
      reviewers[id] = { skills: rSkills, unavailable };
      core.addReviewer(state, { time: 0, source: 't' }, { id, skills: rSkills, unavailable });
    }
    const unionSkills = [...new Set(Object.values(reviewers).flatMap((r) => r.skills))];
    const cases = [];
    for (let i = 0; i < n; i++) {
      const c = {
        id: `C${i}`,
        dept: `D${i % 3}`,
        risk: 10 + Math.floor(rnd() * 90),
        deadline: 1 + Math.floor(rnd() * 6),
        duration: 1,
        skill: unionSkills[Math.floor(rnd() * unionSkills.length)],
      };
      cases.push(c);
      core.openCase(state, { time: 0, source: 't' }, c);
    }
    const { assignments, rejections } = core.runAssign(state, { time: 0, source: 't' });
    for (const a of assignments) assert.equal(rejections[a.caseId], undefined);
    const got = assignments.filter((a) => state.cases[a.caseId].risk >= THRESHOLD).length;
    const want = bruteForceMaxHighRisk(cases, reviewers, 0);
    assert.equal(got, want, `iter ${iter}: scheduler ${got} != optimum ${want}`);
  }
});
