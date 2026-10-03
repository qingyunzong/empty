import { ExitError } from './errors.js';

// Reference implementation used to cross-check the interpreter (acceptance D).
// Deliberately written as full expansion: no early exit, no precomputed index,
// forbidden pairs scanned as a plain list.

export function brutePermission(approvals, plant, kettleId, version, operator, ts) {
  const chain = plant.chainOf(kettleId);
  const applicable = [];
  for (const a of approvals) {
    if (a.kind === 'revoke') continue;
    const dist = chain.findIndex((c) => c.level === a.level && c.id === a.target);
    if (dist < 0) continue;
    if (a.version !== '*' && a.version !== version) continue;
    if (a.operator != null && a.operator !== '*' && a.operator !== operator) continue;
    if (a.ts > ts) continue;
    const revoked = approvals.some((r) => r.kind === 'revoke' && r.revokes === a.id && r.ts <= ts);
    if (revoked) continue;
    applicable.push({ a, dist });
  }
  if (applicable.length === 0) {
    return { decision: 'deny', approval: null, level: null, reason: 'no matching approval' };
  }
  const nearest = Math.min(...applicable.map((x) => x.dist));
  const atNearest = applicable.filter((x) => x.dist === nearest);
  const deny = atNearest.find((x) => x.a.kind === 'deny');
  if (deny) {
    return {
      decision: 'deny',
      approval: deny.a.id,
      level: chain[nearest].level,
      reason: `denied at ${chain[nearest].level} ${chain[nearest].id} by ${deny.a.id}`,
    };
  }
  const grant = atNearest.find((x) => x.a.kind === 'grant');
  return {
    decision: 'allow',
    approval: grant.a.id,
    level: chain[nearest].level,
    reason: `granted at ${chain[nearest].level} ${chain[nearest].id} by ${grant.a.id}`,
  };
}

export function bruteDecide(recipes, approvals, kettleStates, attempt) {
  const plant = recipes.plant;
  if (!plant.kettleIds.has(attempt.kettle)) {
    throw new ExitError(2, `unknown kettle ${attempt.kettle}`);
  }
  const v = recipes.versions.get(attempt.version);
  if (!v) throw new ExitError(2, `unknown version ${attempt.version}`);
  const st = kettleStates.get(attempt.kettle) ?? { fed: [], maxSeq: -Infinity };
  if (v.seq < st.maxSeq) {
    throw new ExitError(
      16,
      `version rollback in kettle ${attempt.kettle}: ${attempt.version} (seq ${v.seq}) after seq ${st.maxSeq}`,
    );
  }
  const perm = brutePermission(approvals, plant, attempt.kettle, attempt.version, attempt.operator, attempt.ts);
  if (perm.decision === 'deny') return perm;
  for (const u of st.fed) {
    const hit = recipes.forbiddenList.some(
      ([a, b]) => (a === u && b === attempt.version) || (b === u && a === attempt.version),
    );
    if (hit) {
      return {
        decision: 'deny',
        approval: perm.approval,
        level: perm.level,
        reason: `forbidden combination ${u} + ${attempt.version} in kettle ${attempt.kettle} (constraint overrides ${perm.approval})`,
        conflictWith: u,
      };
    }
  }
  return perm;
}

export function sortAttempts(attempts) {
  return [...attempts].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function bruteRunAll(recipes, approvals, attempts) {
  const kettleStates = new Map();
  const results = [];
  for (const t of sortAttempts(attempts)) {
    const r = bruteDecide(recipes, approvals, kettleStates, t);
    const rec = {
      attempt: t.id,
      kettle: t.kettle,
      version: t.version,
      ts: t.ts,
      decision: r.decision,
      reason: r.reason,
      approval: r.approval ?? null,
    };
    if (r.conflictWith) rec.conflictWith = r.conflictWith;
    results.push(rec);
    if (r.decision === 'allow') {
      const st = kettleStates.get(t.kettle) ?? { fed: [], maxSeq: -Infinity };
      st.fed.push(t.version);
      st.maxSeq = Math.max(st.maxSeq, recipes.versions.get(t.version).seq);
      kettleStates.set(t.kettle, st);
    }
  }
  return { results, kettleStates };
}
