'use strict';

// Independent brute-force enumerator used as the ground-truth baseline for
// the production scheduler. Maximizes (on-time high-risk count, total
// on-time count) lexicographically, subject to skill, slot, deadline and
// department-quota constraints.
function bruteForceOptimal(cases, reviewers, now, config = {}) {
  const highRisk = config.highRisk ?? 8;
  const share = config.deptShare ?? 0.5;
  const cap = Math.max(1, Math.floor(share * reviewers.length));
  const quotaActive = new Set(cases.map((c) => c.dept)).size > 1;
  let best = null;
  const assign = new Array(cases.length).fill(null);

  function blocked(reviewerId, s, e) {
    const r = reviewers.find((x) => x.id === reviewerId);
    for (const iv of r.unavailable || []) {
      if (s < iv.end && iv.start < e) return true;
    }
    for (let j = 0; j < cases.length; j++) {
      const a = assign[j];
      if (a && a.reviewerId === reviewerId && s < a.end && a.start < e) return true;
    }
    return false;
  }

  function rec(i, high, total) {
    if (i === cases.length) {
      if (!best || high > best.high || (high === best.high && total > best.total)) {
        best = { high, total };
      }
      return;
    }
    const c = cases[i];
    for (const r of reviewers) {
      if (!(r.skills || []).includes(c.skill)) continue;
      for (let s = now; s + c.duration <= c.deadline; s++) {
        const e = s + c.duration;
        if (blocked(r.id, s, e)) continue;
        if (quotaActive) {
          let cnt = 0;
          for (let j = 0; j < cases.length; j++) {
            if (assign[j] && cases[j].dept === c.dept) cnt++;
          }
          if (cnt >= cap) continue;
        }
        assign[i] = { reviewerId: r.id, start: s, end: e };
        rec(i + 1, high + (c.risk >= highRisk ? 1 : 0), total + 1);
        assign[i] = null;
      }
    }
    rec(i + 1, high, total);
  }
  rec(0, 0, 0);
  return best || { high: 0, total: 0 };
}

function coverage(assignments, cases, config = {}) {
  const highRisk = config.highRisk ?? 8;
  const byId = new Map(cases.map((c) => [c.id, c]));
  let high = 0;
  for (const a of assignments) {
    const c = byId.get(a.caseId);
    if (c && c.risk >= highRisk && a.end <= c.deadline) high++;
  }
  return { high, total: assignments.length };
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomInstance(rand, { n, reviewers }) {
  const cases = [];
  const depts = ['cardio', 'neuro'];
  const skills = ['echo', 'ct'];
  for (let i = 0; i < n; i++) {
    cases.push({
      id: `C${i}`,
      dept: depts[Math.floor(rand() * depts.length)],
      risk: Math.floor(rand() * 11),
      deadline: 4 + Math.floor(rand() * 8),
      skill: skills[Math.floor(rand() * skills.length)],
      duration: 1 + Math.floor(rand() * 3),
      openedAt: 0,
      credit: 0,
    });
  }
  const rv = reviewers.map((r, i) => ({
    id: r.id || `R${i}`,
    skills: r.skills,
    unavailable: rand() < 0.5 ? [{ start: 1, end: 2 + Math.floor(rand() * 2) }] : [],
  }));
  return { cases, reviewers: rv };
}

module.exports = { bruteForceOptimal, coverage, lcg, randomInstance };
