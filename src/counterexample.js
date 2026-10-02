import { resolvePermission } from './interpreter.js';
import { refOf } from './model.js';

// A subset of grants is chain-closed when every non-factory grant has a
// matching parent grant inside the subset.
export function chainClosed(model, subset) {
  const has = (level, g, workshop) =>
    subset.some((r) =>
      r.level === level &&
      r.recipe === g.recipe &&
      r.version === g.version &&
      (level !== 'workshop' || r.workshop === workshop));
  for (const g of subset) {
    if (g.level === 'workshop' && !has('factory', g)) return false;
    if (g.level === 'reactor') {
      const ws = model.reactorToWorkshop.get(g.reactor);
      if (!has('workshop', g, ws)) return false;
    }
  }
  return true;
}

// Find the minimal set of approvals that would make the permission layer
// allow a feed which is dangerous (forbidden combination with the current
// reactor contents). The real interpreter still denies it because the
// constraint layer wins; the output documents exactly which approvals an
// attacker/misconfiguration would need for the feed to be *wrongly* allowed
// if the constraint layer were bypassed.
export function findCounterexample(model, candidateGrants, contents, reactor, recipe, version) {
  const ref = refOf(recipe, version);
  const conflicts = [...contents]
    .filter((c) => (model.forbidden.get(c) ?? new Set()).has(ref))
    .sort();
  if (!conflicts.length) return { dangerous: false };

  const workshop = model.reactorToWorkshop.get(reactor);
  const relevant = candidateGrants
    .filter((g) => {
      if (g.recipe !== recipe || g.version !== version) return false;
      if (g.level === 'factory') return true;
      if (g.level === 'workshop') return g.workshop === workshop;
      return g.reactor === reactor;
    })
    .map((g) => ({ ...g, active: true, parent: null }));
  relevant.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (relevant.length > 16) {
    throw new Error(`too many candidate approvals (${relevant.length}) for exhaustive search`);
  }

  const n = relevant.length;
  for (let size = 0; size <= n; size++) {
    const picked = [];
    let found = null;
    const walk = (start) => {
      if (picked.length === size) {
        if (chainClosed(model, picked) && resolvePermission(model, picked, reactor, recipe, version).permitted) {
          found = [...picked];
          return true;
        }
        return false;
      }
      for (let i = start; i < n; i++) {
        picked.push(relevant[i]);
        if (walk(i + 1)) return true;
        picked.pop();
      }
      return false;
    };
    if (walk(0)) {
      return {
        dangerous: true,
        conflicts,
        minimalApprovals: found.map((g) => g.id).sort(),
        size: found.length,
      };
    }
  }
  return { dangerous: true, conflicts, minimalApprovals: null, size: 0 };
}
