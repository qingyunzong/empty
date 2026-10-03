import { ExitError } from './errors.js';
import { resolveTarget } from './map.js';

export function validateGrants(idx, grants) {
  const ids = new Set();
  for (const g of grants) {
    if (!g.id || ids.has(g.id)) throw new ExitError(2, `grant id missing or duplicate: ${g.id}`);
    ids.add(g.id);
    if (g.op !== 'grant' && g.op !== 'revoke') throw new ExitError(2, `grant ${g.id}: bad op ${g.op}`);
    if (!['zone', 'aisle', 'shelf'].includes(g.level)) throw new ExitError(2, `grant ${g.id}: bad level ${g.level}`);
    const zone = idx.zones.get(g.zone);
    if (!zone) throw new ExitError(2, `grant ${g.id}: unknown zone ${g.zone}`);
    if (g.level !== 'zone') {
      const aisle = idx.aisles.get(g.aisle);
      if (!aisle || aisle.zone.id !== zone.id) throw new ExitError(2, `grant ${g.id}: unknown aisle ${g.aisle} in zone ${g.zone}`);
      if (g.level === 'shelf') {
        const shelf = idx.shelves.get(g.shelf);
        if (!shelf || shelf.aisle.id !== aisle.id) throw new ExitError(2, `grant ${g.id}: unknown shelf ${g.shelf} in aisle ${g.aisle}`);
      }
    }
    if (typeof g.time !== 'number') throw new ExitError(2, `grant ${g.id}: missing effective time`);
  }
}

export function validateTask(task) {
  if (!task.id) throw new ExitError(2, 'task missing id');
  const kind = task.kind ?? 'normal';
  if (!['normal', 'rescue'].includes(kind)) throw new ExitError(2, `task ${task.id}: bad kind ${task.kind}`);
  const d = task.dispatch;
  if (
    !d || typeof d.event !== 'string' || typeof d.lamport !== 'number' ||
    !Array.isArray(d.parents ?? []) || typeof d.time !== 'number'
  ) {
    throw new ExitError(2, `task ${task.id}: dispatch requires event/lamport/parents/time`);
  }
  if (!task.target) throw new ExitError(2, `task ${task.id}: missing target`);
}

export function grantCoversTarget(grant, target) {
  if (grant.level === 'zone') return grant.zone === target.zone;
  if (grant.level === 'aisle') return grant.zone === target.zone && grant.aisle === target.aisle;
  return grant.zone === target.zone && grant.aisle === target.aisle && grant.shelf === target.shelf;
}

function revokeMatchesGrant(revoke, grant) {
  return (
    revoke.subject === grant.subject &&
    revoke.level === grant.level &&
    (revoke.zone ?? null) === (grant.zone ?? null) &&
    (revoke.aisle ?? null) === (grant.aisle ?? null) &&
    (revoke.shelf ?? null) === (grant.shelf ?? null)
  );
}

function subjectMatches(grant, task) {
  const subject = task.subject ?? '*';
  return grant.subject === '*' || subject === '*' || grant.subject === subject;
}

function inheritancePath(grant, target) {
  const parts = [`zone:${target.zone}`];
  if (target.aisle != null) parts.push(`aisle:${target.aisle}`);
  if (target.shelf != null) parts.push(`shelf:${target.shelf}`);
  return `${parts.join(' -> ')} (granted at ${grant.level})`;
}

export function evaluateTask(idx, grants, task, events) {
  const target = resolveTarget(idx, task.target);
  const base = { zone: target.zone.id, zoneKind: target.zone.kind };
  if (target.zone.kind === 'normal') {
    return { allowed: true, reason: 'open-zone', ...base };
  }
  const dispatch = task.dispatch;
  const revokes = grants.filter((g) => g.op === 'revoke');
  const candidates = grants.filter(
    (g) => g.op === 'grant' && grantCoversTarget(g, task.target) && subjectMatches(g, task),
  );
  const unseen = [];
  const inactive = [];
  for (const g of candidates) {
    if (!events.isCausallyBefore(g.event, dispatch.event)) {
      unseen.push(g.id);
      continue;
    }
    const from = g.from ?? 0;
    const to = g.to ?? Infinity;
    const cuts = revokes
      .filter(
        (r) =>
          revokeMatchesGrant(r, g) &&
          events.isCausallyBefore(r.event, dispatch.event) &&
          r.time <= dispatch.time,
      )
      .map((r) => r.time);
    const effectiveTo = Math.min(to, ...cuts);
    if (dispatch.time >= from && dispatch.time < effectiveTo) {
      let tempPass;
      const occupyUntil = task.occupyUntil;
      if (typeof occupyUntil === 'number' && occupyUntil > dispatch.time) {
        const futureCuts = revokes.filter(
          (r) => revokeMatchesGrant(r, g) && r.time > dispatch.time && r.time <= occupyUntil,
        );
        if (futureCuts.length) {
          tempPass = {
            until: occupyUntil,
            revokedBy: futureCuts.map((r) => r.id),
            note: 'aisle occupied before revocation; temporary pass retained until completion, not reusable by new tasks',
          };
        }
      }
      return {
        allowed: true,
        reason: 'grant',
        grant: g.id,
        level: g.level,
        inheritedFrom: inheritancePath(g, task.target),
        causalChain: events.causalPath(g.event, dispatch.event),
        ...(tempPass ? { tempPass } : {}),
        ...base,
      };
    }
    inactive.push({ grant: g.id, from, effectiveTo: effectiveTo === Infinity ? null : effectiveTo });
  }
  let reason;
  if (candidates.length === 0) reason = 'no-grant-for-target';
  else if (unseen.length === candidates.length) reason = 'grant-not-visible';
  else reason = 'grant-expired-or-revoked';
  return { allowed: false, reason, unseenGrants: unseen, inactiveGrants: inactive, ...base };
}

export function findCounterexamples(idx, grants, task, events) {
  const out = [];
  for (const r of grants.filter((g) => g.op === 'revoke')) {
    const d = evaluateTask(idx, grants.filter((g) => g !== r), task, events);
    if (d.allowed) {
      out.push({
        removeRevocation: r.id,
        resultingGrant: d.grant ?? null,
        evidence: `without revocation ${r.id} (event ${r.event} @t=${r.time}), grant ${d.grant} covers ${d.inheritedFrom} at dispatch t=${task.dispatch.time}`,
        causalChain: d.causalChain ?? null,
      });
    }
  }
  return out;
}

export function enumerateReachableZones(idx, grants, task, events) {
  const reachable = [];
  const allows = (target) => evaluateTask(idx, grants, { ...task, target }, events).allowed;
  for (const zone of idx.zones.values()) {
    if (zone.kind === 'normal') {
      reachable.push(zone.id);
      continue;
    }
    let ok = allows({ zone: zone.id });
    if (!ok) {
      for (const aisle of zone.aisles) {
        ok = allows({ zone: zone.id, aisle: aisle.id });
        if (!ok) {
          for (const shelf of aisle.shelves) {
            if (allows({ zone: zone.id, aisle: aisle.id, shelf: shelf.id })) {
              ok = true;
              break;
            }
          }
        }
        if (ok) break;
      }
    }
    if (ok) reachable.push(zone.id);
  }
  return reachable;
}
