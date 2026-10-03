'use strict';

const DEFAULTS = {
  deptShare: 0.5,
  highRisk: 8,
  compensationCredit: 5,
  exactLimit: 9,
};

function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

function fits(busy, start, end) {
  for (const [bs, be] of busy) {
    if (overlaps(start, end, bs, be)) return false;
  }
  return true;
}

function candidateStarts(now, busy) {
  const set = new Set([now]);
  for (const [, e] of busy) {
    if (e > now) set.add(e);
  }
  return [...set].sort((a, b) => a - b);
}

function priorityOf(c, now) {
  const age = Math.max(0, now - (c.openedAt || 0));
  return c.risk * 1000 + (c.credit || 0) * 100 + age;
}

function compareIdentity(a, b) {
  if (a.deadline !== b.deadline) return a.deadline - b.deadline;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byPriority(now) {
  return (a, b) => priorityOf(b, now) - priorityOf(a, now) || compareIdentity(a, b);
}

function deptCap(reviewerCount, config) {
  return Math.max(1, Math.floor((config.deptShare ?? DEFAULTS.deptShare) * reviewerCount));
}

function sortedReviewers(reviewers) {
  return [...reviewers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function busyMapFor(reviewers, fixedAssignments) {
  const map = new Map();
  for (const r of reviewers) {
    map.set(r.id, (r.unavailable || []).map((iv) => [iv.start, iv.end]));
  }
  for (const a of fixedAssignments || []) {
    if (map.has(a.reviewerId)) map.get(a.reviewerId).push([a.start, a.end]);
  }
  return map;
}

function findSlot(c, reviewerList, busyMap, now) {
  let best = null;
  for (const r of reviewerList) {
    const busy = busyMap.get(r.id);
    for (const s of candidateStarts(now, busy)) {
      const e = s + c.duration;
      if (e > c.deadline) continue;
      if (!fits(busy, s, e)) continue;
      if (
        !best ||
        e < best.end ||
        (e === best.end && (s < best.start || (s === best.start && r.id < best.reviewerId)))
      ) {
        best = { caseId: c.id, reviewerId: r.id, start: s, end: e };
      }
    }
  }
  return best;
}

function skilledReviewers(c, reviewers) {
  return reviewers.filter((r) => (r.skills || []).includes(c.skill));
}

function rejectionCode(deadlinePast, skilled, quotaActive, deptFull) {
  if (skilled.length === 0) return 'SKILL_MISMATCH';
  if (quotaActive && deptFull) return 'QUOTA_DEFERRED';
  if (deadlinePast) return 'DEADLINE_PAST';
  return 'NO_ONTIME_SLOT';
}

function planGreedy(cases, reviewers, now, config, fixed) {
  const cap = deptCap(reviewers.length, config);
  const quotaActive = new Set(cases.map((c) => c.dept)).size > 1;
  const busyMap = busyMapFor(reviewers, fixed);
  const deptCounts = {};
  for (const a of fixed || []) {
    if (a.dept && a.end > now) deptCounts[a.dept] = (deptCounts[a.dept] || 0) + 1;
  }
  const assignments = [];
  const rejections = [];
  for (const c of [...cases].sort(byPriority(now))) {
    const skilled = skilledReviewers(c, reviewers);
    if (skilled.length === 0) {
      rejections.push({ caseId: c.id, code: 'SKILL_MISMATCH' });
      continue;
    }
    if (quotaActive && (deptCounts[c.dept] || 0) >= cap) {
      rejections.push({ caseId: c.id, code: 'QUOTA_DEFERRED' });
      continue;
    }
    const slot = findSlot(c, skilled, busyMap, now);
    if (!slot) {
      rejections.push({
        caseId: c.id,
        code: c.deadline <= now ? 'DEADLINE_PAST' : 'NO_ONTIME_SLOT',
      });
      continue;
    }
    assignments.push(slot);
    busyMap.get(slot.reviewerId).push([slot.start, slot.end]);
    deptCounts[c.dept] = (deptCounts[c.dept] || 0) + 1;
  }
  return { assignments, rejections };
}

function planExact(cases, reviewers, now, config, fixed) {
  const cap = deptCap(reviewers.length, config);
  const quotaActive = new Set(cases.map((c) => c.dept)).size > 1;
  const highRisk = config.highRisk ?? DEFAULTS.highRisk;
  const busyMap = busyMapFor(reviewers, fixed);
  const order = [...cases].sort(byPriority(now));
  const fixedDeptCounts = {};
  for (const a of fixed || []) {
    if (a.dept && a.end > now) fixedDeptCounts[a.dept] = (fixedDeptCounts[a.dept] || 0) + 1;
  }
  const skilledCache = new Map(order.map((c) => [c.id, skilledReviewers(c, reviewers)]));
  const suffixHigh = new Array(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    suffixHigh[i] = suffixHigh[i + 1] + (order[i].risk >= highRisk ? 1 : 0);
  }
  // In a left-shifted optimal schedule every task starts at `now`, at an
  // unavailability end, or at such a point plus the summed durations of the
  // tasks scheduled before it on the same reviewer. Subset sums of durations
  // therefore make the candidate-start set complete.
  const subsetSums = (() => {
    let sums = new Set([0]);
    for (const c of cases) {
      const next = new Set(sums);
      for (const x of sums) next.add(x + c.duration);
      sums = next;
    }
    return [...sums];
  })();
  const startCache = new Map();
  const startsFor = (c, r) => {
    const key = c.id + '@' + r.id;
    let list = startCache.get(key);
    if (!list) {
      const set = new Set();
      for (const x of subsetSums) {
        const s = now + x;
        if (s + c.duration <= c.deadline) set.add(s);
      }
      for (const iv of r.unavailable || []) {
        for (const x of subsetSums) {
          const s = iv.end + x;
          if (s >= now && s + c.duration <= c.deadline) set.add(s);
        }
      }
      list = [...set].sort((a, b) => a - b);
      startCache.set(key, list);
    }
    return list;
  };
  let best = null;
  const current = [];
  const currentDeptCounts = {};

  function rec(i, curHigh, curTotal) {
    if (best) {
      const rem = order.length - i;
      if (curHigh + suffixHigh[i] < best.high) return;
      if (curHigh + suffixHigh[i] === best.high && curTotal + rem <= best.total) return;
    }
    if (i === order.length) {
      if (!best || curHigh > best.high || (curHigh === best.high && curTotal > best.total)) {
        best = { high: curHigh, total: curTotal, assignments: current.map((a) => ({ ...a })) };
      }
      return;
    }
    const c = order[i];
    const skilled = skilledCache.get(c.id);
    const deptFull =
      quotaActive && (fixedDeptCounts[c.dept] || 0) + (currentDeptCounts[c.dept] || 0) >= cap;
    if (skilled.length > 0 && !deptFull) {
      for (const r of skilled) {
        const busy = busyMap.get(r.id);
        for (const s of startsFor(c, r)) {
          const e = s + c.duration;
          if (!fits(busy, s, e)) continue;
          busy.push([s, e]);
          current.push({ caseId: c.id, reviewerId: r.id, start: s, end: e });
          currentDeptCounts[c.dept] = (currentDeptCounts[c.dept] || 0) + 1;
          rec(i + 1, curHigh + (c.risk >= highRisk ? 1 : 0), curTotal + 1);
          currentDeptCounts[c.dept] -= 1;
          current.pop();
          busy.pop();
        }
      }
    }
    rec(i + 1, curHigh, curTotal);
  }
  rec(0, 0, 0);

  const chosen = best ? best.assignments : [];
  const chosenDeptCounts = {};
  for (const a of chosen) {
    const c = order.find((x) => x.id === a.caseId);
    chosenDeptCounts[c.dept] = (chosenDeptCounts[c.dept] || 0) + 1;
  }
  const assignedIds = new Set(chosen.map((a) => a.caseId));
  const rejections = [];
  for (const c of order) {
    if (assignedIds.has(c.id)) continue;
    const skilled = skilledCache.get(c.id);
    const deptFull =
      quotaActive &&
      (fixedDeptCounts[c.dept] || 0) + (chosenDeptCounts[c.dept] || 0) >= cap;
    rejections.push({
      caseId: c.id,
      code: rejectionCode(c.deadline <= now, skilled, quotaActive, deptFull),
    });
  }
  return { assignments: chosen, rejections };
}

function bumpPass(plan, cases, reviewers, now, config, fixed) {
  const highRisk = config.highRisk ?? DEFAULTS.highRisk;
  const comp = config.compensationCredit ?? DEFAULTS.compensationCredit;
  const byId = new Map(cases.map((c) => [c.id, c]));
  const preemptions = [];
  const compensations = [];
  for (const rej of [...plan.rejections]) {
    const c = byId.get(rej.caseId);
    if (!c || c.risk < highRisk || rej.code !== 'NO_ONTIME_SLOT') continue;
    const victims = plan.assignments
      .filter((a) => a.start > now && byId.get(a.caseId).risk < c.risk)
      .sort((a, b) => byId.get(a.caseId).risk - byId.get(b.caseId).risk || a.start - b.start);
    for (const victim of victims) {
      const idx = plan.assignments.indexOf(victim);
      plan.assignments.splice(idx, 1);
      const busyMap = busyMapFor(reviewers, [...(fixed || []), ...plan.assignments]);
      const slot = findSlot(
        c,
        skilledReviewers(c, reviewers).filter((r) => r.id === victim.reviewerId),
        busyMap,
        now
      );
      if (!slot) {
        plan.assignments.splice(idx, 0, victim);
        continue;
      }
      plan.assignments.push(slot);
      busyMap.get(slot.reviewerId).push([slot.start, slot.end]);
      const vc = byId.get(victim.caseId);
      const vslot = findSlot(vc, skilledReviewers(vc, reviewers), busyMap, now);
      if (vslot) {
        plan.assignments.push(vslot);
      } else {
        plan.rejections.push({ caseId: vc.id, code: 'PREEMPTED' });
        compensations.push({ caseId: vc.id, credit: comp });
      }
      preemptions.push({
        preempted: victim.caseId,
        by: c.id,
        reviewerId: victim.reviewerId,
        at: victim.start,
      });
      plan.rejections.splice(plan.rejections.indexOf(rej), 1);
      break;
    }
  }
  return { preemptions, compensations };
}

function schedule(cases, reviewers, now, config = {}, fixed = []) {
  const cfg = { ...DEFAULTS, ...config };
  const sorted = sortedReviewers(reviewers);
  const method = cases.length <= cfg.exactLimit ? 'exact' : 'greedy';
  const plan =
    method === 'exact'
      ? planExact(cases, sorted, now, cfg, fixed)
      : planGreedy(cases, sorted, now, cfg, fixed);
  const { preemptions, compensations } = bumpPass(plan, cases, sorted, now, cfg, fixed);
  return {
    method,
    assignments: plan.assignments,
    rejections: plan.rejections,
    preemptions,
    compensations,
  };
}

module.exports = {
  DEFAULTS,
  schedule,
  planExact,
  planGreedy,
  priorityOf,
  byPriority,
  deptCap,
  candidateStarts,
  fits,
  findSlot,
};
