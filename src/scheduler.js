import { ExitError, EXIT } from './errors.js';
import { buildClockIndex, isAncestor, causalChain } from './clock.js';
import { indexMap, resolveTarget } from './map.js';

// A grant covers a target by inheritance: zone grant -> its aisles -> their
// shelves; aisle grant -> its shelves; shelf grant -> that shelf only.
function covers(grant, mapIndex, target) {
  // Pure zone target: any grant at/inside the zone authorizes entering it.
  if (target.shelfId == null && target.aisleId == null) {
    return coversZone(grant, mapIndex, target.zoneId);
  }
  if (grant.zone != null) return grant.zone === target.zoneId;
  if (grant.aisle != null) return grant.aisle === target.aisleId;
  if (grant.shelf != null) return grant.shelf === target.shelfId;
  return false;
}

function coversZone(grant, mapIndex, zoneId) {
  if (grant.zone != null) return grant.zone === zoneId;
  if (grant.aisle != null) return mapIndex.aisles.get(grant.aisle)?.zoneId === zoneId;
  if (grant.shelf != null) return mapIndex.shelves.get(grant.shelf)?.zoneId === zoneId;
  return false;
}

// Revocations segment a grant by effective time: a revoke at time `at` ends
// every segment at `at`. activeAt checks the segment containing time t.
function makeActiveAt(revokesByGrant) {
  return (grant, t, ignoreRevokeId = null) => {
    if (!(grant.from <= t && t < grant.to)) return false;
    for (const revoke of revokesByGrant.get(grant.id) ?? []) {
      if (revoke.id !== ignoreRevokeId && revoke.at <= t) return false;
    }
    return true;
  };
}

export function schedule({ map, tasks, grants }) {
  const mapIndex = indexMap(map); // may throw exit 23
  const events = [...grants, ...tasks];
  const byId = buildClockIndex(events); // may throw exit 22

  const grantEvents = grants.filter((g) => g.kind === 'grant');
  const revokesByGrant = new Map();
  for (const revoke of grants.filter((g) => g.kind === 'revoke')) {
    if (!revokesByGrant.has(revoke.target)) revokesByGrant.set(revoke.target, []);
    revokesByGrant.get(revoke.target).push(revoke);
  }
  for (const list of revokesByGrant.values()) list.sort((a, b) => a.at - b.at);
  const activeAt = makeActiveAt(revokesByGrant);

  const enumerate = tasks.length <= 10;
  const plan = [];
  const deny = [];

  for (const task of tasks) {
    const record = decide(task, { mapIndex, byId, grantEvents, revokesByGrant, activeAt });
    if (enumerate) {
      record.reachableZones = reachableZones(task, { mapIndex, byId, grantEvents, activeAt });
    }
    (record.decision === 'allow' ? plan : deny).push(record);
  }
  return { plan, deny };
}

function decide(task, ctx) {
  const { mapIndex, byId, grantEvents, revokesByGrant, activeAt } = ctx;
  const target = resolveTarget(mapIndex, task.target); // may throw exit 23
  const base = { task: task.id, subject: task.subject, time: task.time };
  if (!target) {
    return { ...base, decision: 'deny', reasons: ['unknown-target'], counterexamples: [] };
  }
  const zone = mapIndex.zones.get(target.zoneId);
  const record = { ...base, zone: zone.id, kind: zone.kind };

  if (zone.kind === 'normal') {
    return { ...record, decision: 'allow', reason: 'open-zone' };
  }

  const candidates = grantEvents.filter(
    (g) => g.subject === task.subject && covers(g, mapIndex, target),
  );
  const visible = (g) => isAncestor(byId, g.id, task.id); // 先见授权后派单
  const usable = candidates.filter((g) => visible(g) && activeAt(g, task.time));

  if (usable.length > 0) {
    const grant = usable[0];
    const out = {
      ...record,
      decision: 'allow',
      reason: 'grant-active',
      grant: grant.id,
      causalChain: causalChain(byId, grant.id, task.id),
    };
    // Temporary pass: grant is revoked after dispatch but before completion.
    // The pass is bound to this task id and is never reusable by new tasks.
    const revoke = (revokesByGrant.get(grant.id) ?? []).find(
      (r) => r.at > task.time && r.at <= (task.completeTime ?? task.time),
    );
    if (revoke) {
      out.tempPass = { until: task.completeTime, revoke: revoke.id, reusable: false };
    }
    return out;
  }

  const reasons = [];
  if (candidates.length === 0) {
    reasons.push('no-grant');
  } else {
    if (candidates.some((g) => !visible(g))) reasons.push('grant-not-causally-visible');
    if (candidates.some((g) => visible(g) && !activeAt(g, task.time))) {
      reasons.push(
        (revokesByGrant.get(candidates.find((g) => visible(g) && !activeAt(g, task.time)).id) ?? [])
          .some((r) => r.at <= task.time)
          ? 'grant-revoked'
          : 'grant-out-of-window',
      );
    }
  }

  // Life-rescue exception: may override a restricted-zone deny, but only with
  // dual authorization by two distinct people. Same person twice -> exit 24.
  if (task.type === 'rescue' && zone.kind === 'restricted') {
    const authorizers = task.authorizers ?? [];
    if (new Set(authorizers).size !== authorizers.length) {
      throw new ExitError(
        EXIT.DUPLICATE_AUTHORIZER,
        `rescue task ${task.id} dual authorization by the same person`,
      );
    }
    if (authorizers.length >= 2) {
      return {
        ...record,
        decision: 'allow',
        reason: 'rescue-override',
        exception: {
          type: 'rescue-override',
          authorizers,
          deniedReasons: reasons,
          audit: `rescue task ${task.id} entered restricted zone ${zone.id} under dual authorization`,
        },
      };
    }
    reasons.push('rescue-requires-dual-authorization');
  }

  // Counterexample generation: which single revocation, if deleted, would make
  // this task legal (grant visible and its segment covering task.time restored).
  const counterexamples = [];
  for (const grant of candidates) {
    if (!visible(grant)) continue;
    for (const revoke of revokesByGrant.get(grant.id) ?? []) {
      if (revoke.at <= task.time && activeAt(grant, task.time, revoke.id)) {
        counterexamples.push({
          removeRevoke: revoke.id,
          grant: grant.id,
          restoredSegment: [grant.from, grant.to],
          then: 'allow',
        });
      }
    }
  }

  return { ...record, decision: 'deny', reasons, counterexamples };
}

// Acceptance D support: enumerate every zone this task could legally enter.
function reachableZones(task, { mapIndex, byId, grantEvents, activeAt }) {
  const result = [];
  for (const zone of mapIndex.zones.values()) {
    if (zone.kind === 'normal') {
      result.push(zone.id);
      continue;
    }
    const ok = grantEvents.some(
      (g) =>
        g.subject === task.subject &&
        coversZone(g, mapIndex, zone.id) &&
        isAncestor(byId, g.id, task.id) &&
        activeAt(g, task.time),
    );
    if (ok) result.push(zone.id);
  }
  return result.sort();
}
