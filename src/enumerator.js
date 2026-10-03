// Independent brute-force enumerator used to cross-check the solver.
// Enumerates every coord-bin assignment over the stars' domains and checks
// all constraints directly; shares only the structural checkers with the
// solver, never its propagation or search code.

import { buildStarTable, structuralViolations } from './solver.js';

export function enumerate(obsList, limits) {
  if (structuralViolations(obsList, limits).length > 0) {
    return { status: 'UNSAT' };
  }
  const stars = buildStarTable(obsList, limits);
  const names = [...stars.keys()].sort();
  const domains = names.map((name) => [...stars.get(name).domains.coord].sort((a, b) => a - b));
  const assignment = new Map();
  const used = new Set();

  const visit = (index) => {
    if (index === names.length) return true;
    for (const value of domains[index]) {
      if (used.has(value)) continue;
      used.add(value);
      assignment.set(names[index], value);
      if (visit(index + 1)) return true;
      used.delete(value);
      assignment.delete(names[index]);
    }
    return false;
  };

  if (!visit(0)) return { status: 'UNSAT' };
  const model = {};
  for (const name of names) {
    model[name] = {
      coord: assignment.get(name),
      mag: Math.min(...stars.get(name).domains.mag),
      cred: Math.min(...stars.get(name).domains.cred),
    };
  }
  return { status: 'SAT', model };
}

// Verify that a candidate model satisfies every constraint.
export function validateModel(obsList, limits, model) {
  if (model === null || typeof model !== 'object') return false;
  if (structuralViolations(obsList, limits).length > 0) return false;
  const stars = buildStarTable(obsList, limits);
  const names = [...stars.keys()];
  if (Object.keys(model).sort().join('') !== [...names].sort().join('')) return false;
  const coords = new Set();
  for (const name of names) {
    const entry = model[name];
    if (!entry || !Number.isInteger(entry.coord) || !Number.isInteger(entry.mag) || !Number.isInteger(entry.cred)) return false;
    const domains = stars.get(name).domains;
    if (!domains.coord.has(entry.coord)) return false;
    if (!domains.mag.has(entry.mag)) return false;
    if (!domains.cred.has(entry.cred)) return false;
    if (coords.has(entry.coord)) return false;
    coords.add(entry.coord);
  }
  return true;
}
