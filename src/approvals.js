import { ExitError } from './errors.js';

const LEVEL_ORDER = { factory: 0, workshop: 1, kettle: 2 };

// Validates approvals.jsonl entries.
// Chain integrity (exit 17 on violation):
//  - a revoke must reference an existing non-revoke approval
//  - an optional `parent` pointer must reference an existing grant at a
//    strictly higher level whose target is an ancestor of this target
export function validateApprovals(list, recipes) {
  const plant = recipes.plant;
  const byId = new Map();
  for (const a of list) {
    if (!a || typeof a.id !== 'string') throw new ExitError(2, 'approval missing id');
    if (byId.has(a.id)) throw new ExitError(2, `duplicate approval id ${a.id}`);
    byId.set(a.id, a);
  }
  for (const a of list) {
    if (a.kind === 'revoke') {
      const target = byId.get(a.revokes);
      if (!target) {
        throw new ExitError(17, `revoke ${a.id} references missing approval ${a.revokes}`);
      }
      if (target.kind === 'revoke') {
        throw new ExitError(17, `revoke ${a.id} cannot target revoke ${a.revokes}`);
      }
      continue;
    }
    if (a.kind !== 'grant' && a.kind !== 'deny') {
      throw new ExitError(2, `approval ${a.id}: unknown kind ${a.kind}`);
    }
    if (!(a.level in LEVEL_ORDER)) {
      throw new ExitError(2, `approval ${a.id}: unknown level ${a.level}`);
    }
    if (!plant.has(a.level, a.target)) {
      throw new ExitError(2, `approval ${a.id}: unknown ${a.level} ${a.target}`);
    }
    if (a.version !== '*' && !recipes.versions.has(a.version)) {
      throw new ExitError(2, `approval ${a.id}: unknown version ${a.version}`);
    }
    if (typeof a.ts !== 'number') throw new ExitError(2, `approval ${a.id} missing ts`);
    if (a.parent != null) {
      const p = byId.get(a.parent);
      if (!p) throw new ExitError(17, `approval ${a.id}: parent ${a.parent} not found`);
      if (p.kind !== 'grant') {
        throw new ExitError(17, `approval ${a.id}: parent ${a.parent} is not a grant`);
      }
      if (LEVEL_ORDER[p.level] >= LEVEL_ORDER[a.level]) {
        throw new ExitError(
          17,
          `approval chain broken at ${a.id}: parent level ${p.level} not above ${a.level}`,
        );
      }
      if (!isAncestor(plant, p.level, p.target, a.level, a.target)) {
        throw new ExitError(
          17,
          `approval chain broken at ${a.id}: ${p.level} ${p.target} is not an ancestor of ${a.level} ${a.target}`,
        );
      }
    }
  }
  return byId;
}

function isAncestor(plant, pLevel, pId, level, id) {
  if (pLevel === 'factory') {
    if (level === 'workshop') return plant.factoryOf(id) === pId;
    if (level === 'kettle') return plant.factoryOf(plant.workshopOf(id)) === pId;
    return false;
  }
  if (pLevel === 'workshop') {
    return level === 'kettle' && plant.workshopOf(id) === pId;
  }
  return false;
}
