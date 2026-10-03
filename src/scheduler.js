'use strict';

// Skill x time-slot constrained scheduler.
//
// Priority order: effective risk (risk + aging + compensation credits)
// descending, then statutory deadline ascending, then case ID. Department
// fairness caps a single department's share of one run at config.deptQuota.
// Placement uses an augmenting search: a case may relocate already-placed
// (not-yet-started) cases to free a feasible interval, which makes the
// greedy pass an exact matroid greedy for unit-duration instances.

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function effectiveRisk(cfg, c, now) {
  const age = Math.max(0, now - c.openedAt);
  return c.risk + cfg.agingRate * age + cfg.creditWeight * (c.credits || 0);
}

function cloneBusy(busy) {
  const copy = new Map();
  for (const [rid, ivs] of busy) copy.set(rid, ivs.map((iv) => ({ ...iv })));
  return copy;
}

function earliestInterval(c, ctx) {
  let best = null;
  for (const rid of ctx.reviewerIds) {
    const r = ctx.state.reviewers[rid];
    if (!r.skills.includes(c.skill)) continue;
    const ivs = ctx.busy.get(rid);
    for (let start = ctx.now; start + c.duration <= c.deadline; start++) {
      const end = start + c.duration;
      if (!ivs.some((iv) => overlaps(start, end, iv.start, iv.end))) {
        if (!best || start < best.start || (start === best.start && rid < best.reviewer)) {
          best = { reviewer: rid, start, end };
        }
        break;
      }
    }
  }
  return best;
}

function place(c, ctx, visited) {
  const direct = earliestInterval(c, ctx);
  if (direct) {
    ctx.busy.get(direct.reviewer).push({ ...direct, kind: 'placed', caseId: c.id });
    return direct;
  }
  if (visited.has(c.id)) return null;
  visited.add(c.id);
  for (const rid of ctx.reviewerIds) {
    const r = ctx.state.reviewers[rid];
    if (!r.skills.includes(c.skill)) continue;
    for (let start = ctx.now; start + c.duration <= c.deadline; start++) {
      const end = start + c.duration;
      const ivs = ctx.busy.get(rid);
      const hits = ivs.filter((iv) => overlaps(start, end, iv.start, iv.end));
      if (hits.length === 0) continue; // earliestInterval would have found it
      if (hits.some((h) => h.kind !== 'placed')) continue; // locked/unavailable: immovable
      const backup = cloneBusy(ctx.busy);
      const target = ctx.busy.get(rid);
      for (const h of hits) target.splice(target.indexOf(h), 1);
      target.push({ start, end, kind: 'reserved', caseId: c.id });
      let ok = true;
      for (const h of hits) {
        const blocker = ctx.state.cases[h.caseId];
        if (!place(blocker, ctx, visited)) { ok = false; break; }
      }
      if (ok) {
        const reservation = ctx.busy.get(rid).find((iv) => iv.kind === 'reserved' && iv.caseId === c.id);
        reservation.kind = 'placed';
        return { reviewer: rid, start, end };
      }
      ctx.busy = backup;
    }
  }
  return null;
}

function plan(state, now) {
  const cfg = state.config;
  const reviewerIds = Object.keys(state.reviewers).sort();
  const allCases = Object.values(state.cases);

  // Assignments that already started are locked in place.
  const locked = allCases.filter((c) => c.assignment && c.assignment.start < now);
  const eligible = allCases.filter(
    (c) => !locked.includes(c) && (c.status === 'open' || c.status === 'assigned' || c.status === 'preempted')
  );

  const busy = new Map();
  for (const rid of reviewerIds) {
    const ivs = (state.reviewers[rid].unavailable || []).map(([s, e]) => ({
      start: s, end: e, kind: 'unavailable', caseId: null,
    }));
    busy.set(rid, ivs);
  }
  for (const c of locked) {
    busy.get(c.assignment.reviewer).push({
      start: c.assignment.start, end: c.assignment.end, kind: 'locked', caseId: c.id,
    });
  }

  const ctx = { state, busy, now, reviewerIds };
  const sorted = eligible.slice().sort(
    (a, b) =>
      effectiveRisk(cfg, b, now) - effectiveRisk(cfg, a, now) ||
      a.deadline - b.deadline ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const assignments = [];
  const rejections = {};
  const deptCount = {};
  let total = 0;

  sorted.forEach((c, idx) => {
    const wouldShare = ((deptCount[c.dept] || 0) + 1) / (total + 1);
    const othersRemain = sorted.slice(idx + 1).some((o) => o.dept !== c.dept && !rejections[o.id]);
    if (total > 0 && wouldShare > cfg.deptQuota && othersRemain) {
      rejections[c.id] = 'QUOTA_BLOCKED';
      return;
    }
    const slot = place(c, ctx, new Set());
    if (!slot) {
      rejections[c.id] = c.deadline - c.duration < now ? 'DEADLINE_UNREACHABLE' : 'NO_CAPACITY';
      return;
    }
    assignments.push({ caseId: c.id, reviewer: slot.reviewer, start: slot.start, end: slot.end });
    deptCount[c.dept] = (deptCount[c.dept] || 0) + 1;
    total += 1;
  });

  return { assignments, rejections };
}

module.exports = { plan, effectiveRisk, overlaps };
