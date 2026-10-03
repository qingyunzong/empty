import { ExitError } from './errors.js';
import { forbiddenKey } from './recipes.js';

// Index revocations: approval id -> sorted list of revoke entries.
export function indexApprovals(approvals) {
  const revokedBy = new Map();
  for (const a of approvals) {
    if (a.kind !== 'revoke') continue;
    if (!revokedBy.has(a.revokes)) revokedBy.set(a.revokes, []);
    revokedBy.get(a.revokes).push(a);
  }
  for (const l of revokedBy.values()) l.sort((x, y) => x.ts - y.ts);
  return { revokedBy };
}

export function isActiveAt(a, idx, ts) {
  if (a.ts > ts) return false;
  const revs = idx.revokedBy.get(a.id);
  if (revs && revs[0].ts <= ts) return false;
  return true;
}

function matches(a, level, id, version, operator) {
  if (a.level !== level || a.target !== id) return false;
  if (a.version !== '*' && a.version !== version) return false;
  if (a.operator != null && a.operator !== '*' && a.operator !== operator) return false;
  return true;
}

// Permission layer: walk kettle -> workshop -> factory, nearest level wins.
// A deny at a nearer level truncates inheritance from higher levels.
export function permissionAt(approvals, idx, plant, kettleId, version, operator, ts) {
  for (const { level, id } of plant.chainOf(kettleId)) {
    let grant = null;
    let deny = null;
    for (const a of approvals) {
      if (a.kind === 'revoke') continue;
      if (!matches(a, level, id, version, operator)) continue;
      if (!isActiveAt(a, idx, ts)) continue;
      if (a.kind === 'deny' && !deny) deny = a;
      if (a.kind === 'grant' && !grant) grant = a;
    }
    if (deny) {
      return { decision: 'deny', approval: deny.id, level, reason: `denied at ${level} ${id} by ${deny.id}` };
    }
    if (grant) {
      return { decision: 'allow', approval: grant.id, level, reason: `granted at ${level} ${id} by ${grant.id}` };
    }
  }
  return { decision: 'deny', approval: null, level: null, reason: 'no matching approval' };
}

// Full decision for one feed attempt. `kettleStates`: Map kettleId -> {fed:[], maxSeq}.
// Forbidden same-kettle constraints override any grant (constraint wins).
export function decide(recipes, approvals, idx, kettleStates, attempt) {
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

  const perm = permissionAt(approvals, idx, plant, attempt.kettle, attempt.version, attempt.operator, attempt.ts);
  if (perm.decision === 'deny') return perm;

  for (const u of st.fed) {
    if (recipes.forbidden.has(forbiddenKey(u, attempt.version))) {
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
