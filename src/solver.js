// Finite-domain propagation + backtracking solver for the star-catalog problem.
//
// Observation coord/mag/cred fields are finite bin SETS (a single integer is
// normalized to a singleton set): the observation localizes its star to one of
// those bins. A star's domains are the intersections of its observations' sets.
//
// Decision variables: for every star, three finite-domain variables
//   coord in [0, limits.coords), mag in [0, limits.mags), cred in [0, limits.creds).
// A star's domains are the intersection of the values demanded by its active
// observations. Constraints:
//   unique_pk                - at most one active observation per id
//   time_order               - per star, nights strictly increase in arrival order
//   exclusive_attribution    - distinct stars occupy distinct coord bins (alldiff)
//   night_capacity           - at most `capacity` active observations per night
//   attribution_consistency  - a star's observations must agree on coord/mag/cred
//                              (i.e. no domain may become empty)

export const CONSTRAINT_UNIQUE_PK = 'unique_pk';
export const CONSTRAINT_TIME_ORDER = 'time_order';
export const CONSTRAINT_EXCLUSIVE_ATTRIBUTION = 'exclusive_attribution';
export const CONSTRAINT_NIGHT_CAPACITY = 'night_capacity';
export const CONSTRAINT_ATTRIBUTION_CONSISTENCY = 'attribution_consistency';

export const CONSTRAINT_NAMES = Object.freeze([
  CONSTRAINT_UNIQUE_PK,
  CONSTRAINT_TIME_ORDER,
  CONSTRAINT_EXCLUSIVE_ATTRIBUTION,
  CONSTRAINT_NIGHT_CAPACITY,
  CONSTRAINT_ATTRIBUTION_CONSISTENCY,
]);

const VALUE_FIELDS = ['coord', 'mag', 'cred'];

const fullDomain = (n) => new Set(Array.from({ length: n }, (_, i) => i));
const sorted = (set) => [...set].sort((a, b) => a - b);
const onlyOf = (set) => [...set][0];

// Internal control-flow exception: the current (partial) assignment is infeasible.
export class Conflict extends Error {
  constructor(constraint, message) {
    super(message);
    this.name = 'Conflict';
    this.constraint = constraint;
  }
}

// Raised when a budget is exhausted; carries the facts propagated so far.
export class BudgetExceeded extends Error {
  constructor(kind, facts) {
    super(`budget exceeded during ${kind}`);
    this.name = 'BudgetExceeded';
    this.kind = kind; // 'propagation' | 'backtracking'
    this.facts = facts;
  }
}

export function cloneDomains(domains) {
  return new Map([...domains].map(([name, d]) => [name, {
    coord: new Set(d.coord),
    mag: new Set(d.mag),
    cred: new Set(d.cred),
  }]));
}

export function serializeDomains(domains) {
  const out = {};
  for (const [name, d] of [...domains].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[name] = { coord: sorted(d.coord), mag: sorted(d.mag), cred: sorted(d.cred) };
  }
  return out;
}

// Group observations by star and narrow each star's domains to the
// intersection of the values its observations demand.
export function buildStarTable(obsList, limits) {
  const stars = new Map();
  for (const obs of obsList) {
    let entry = stars.get(obs.star);
    if (!entry) {
      entry = {
        obs: [],
        domains: {
          coord: fullDomain(limits.coords),
          mag: fullDomain(limits.mags),
          cred: fullDomain(limits.creds),
        },
      };
      stars.set(obs.star, entry);
    }
    entry.obs.push(obs);
    for (const field of VALUE_FIELDS) {
      const domain = entry.domains[field];
      for (const value of [...domain]) {
        if (!obs[field].includes(value)) domain.delete(value);
      }
    }
  }
  return stars;
}

// Constraint checks that do not require search. Returns sorted constraint names.
export function structuralViolations(obsList, limits) {
  const names = new Set();

  const byId = new Map();
  for (const obs of obsList) byId.set(obs.id, (byId.get(obs.id) ?? 0) + 1);
  for (const count of byId.values()) {
    if (count > 1) names.add(CONSTRAINT_UNIQUE_PK);
  }

  const byStar = new Map();
  for (const obs of obsList) {
    if (!byStar.has(obs.star)) byStar.set(obs.star, []);
    byStar.get(obs.star).push(obs);
  }
  for (const list of byStar.values()) {
    const ordered = [...list].sort((a, b) => a.origin - b.origin);
    for (let i = 1; i < ordered.length; i += 1) {
      if (ordered[i].night <= ordered[i - 1].night) {
        names.add(CONSTRAINT_TIME_ORDER);
        break;
      }
    }
  }

  const byNight = new Map();
  for (const obs of obsList) byNight.set(obs.night, (byNight.get(obs.night) ?? 0) + 1);
  for (const count of byNight.values()) {
    if (count > limits.capacity) names.add(CONSTRAINT_NIGHT_CAPACITY);
  }

  const stars = buildStarTable(obsList, limits);
  for (const entry of stars.values()) {
    for (const field of VALUE_FIELDS) {
      if (entry.domains[field].size === 0) {
        names.add(CONSTRAINT_ATTRIBUTION_CONSISTENCY);
        break;
      }
    }
  }

  return [...names].sort();
}

// Singleton (failed-set) propagation for the coord alldiff constraint.
// Every removed value costs one propagation step via `charge()`, which may
// throw BudgetExceeded. Returns the list of removals (the cascade).
export function propagate(domains, charge) {
  const removals = [];
  let changed = true;
  while (changed) {
    changed = false;
    const owners = new Map(); // coord bin -> star pinned to it
    for (const [name, d] of domains) {
      if (d.coord.size === 0) {
        throw new Conflict(
          CONSTRAINT_ATTRIBUTION_CONSISTENCY,
          `star '${name}' has an empty coord domain`,
        );
      }
      if (d.coord.size === 1) {
        const coord = onlyOf(d.coord);
        if (owners.has(coord)) {
          throw new Conflict(
            CONSTRAINT_EXCLUSIVE_ATTRIBUTION,
            `stars '${owners.get(coord)}' and '${name}' are both pinned to coord bin ${coord}`,
          );
        }
        owners.set(coord, name);
      }
    }
    for (const [name, d] of domains) {
      if (d.coord.size <= 1) continue;
      for (const coord of sorted(d.coord)) {
        if (owners.has(coord)) {
          charge(); // one propagation step; may throw BudgetExceeded
          d.coord.delete(coord);
          removals.push({
            star: name,
            field: 'coord',
            removed: coord,
            because: { star: owners.get(coord), coord },
          });
          changed = true;
        }
      }
      if (d.coord.size === 0) {
        throw new Conflict(
          CONSTRAINT_EXCLUSIVE_ATTRIBUTION,
          `star '${name}' has no coord bin left: every candidate bin is owned by another star`,
        );
      }
    }
  }
  return removals;
}

function pickBranchVariable(domains) {
  let pick = null;
  for (const [name, d] of domains) {
    if (d.coord.size <= 1) continue;
    if (
      pick === null
      || d.coord.size < pick[1].coord.size
      || (d.coord.size === pick[1].coord.size && name < pick[0])
    ) {
      pick = [name, d];
    }
  }
  return pick;
}

function modelFrom(domains) {
  const model = {};
  for (const [name, d] of [...domains].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    model[name] = { coord: onlyOf(d.coord), mag: Math.min(...d.mag), cred: Math.min(...d.cred) };
  }
  return model;
}

function search(domains, budget) {
  propagate(domains, () => {
    if (budget.propagation.used >= budget.propagation.limit) {
      throw new BudgetExceeded('propagation', serializeDomains(domains));
    }
    budget.propagation.used += 1;
  });

  const pick = pickBranchVariable(domains);
  if (pick === null) return modelFrom(domains);

  const [name, domain] = pick;
  for (const value of sorted(domain.coord)) {
    if (budget.backtracking.used >= budget.backtracking.limit) {
      throw new BudgetExceeded('backtracking', serializeDomains(domains));
    }
    budget.backtracking.used += 1;
    const branch = cloneDomains(domains);
    branch.get(name).coord = new Set([value]);
    try {
      return search(branch, budget);
    } catch (error) {
      if (error instanceof Conflict) continue; // try the next value
      throw error;
    }
  }
  throw new Conflict(CONSTRAINT_EXCLUSIVE_ATTRIBUTION, 'all coord assignments exhausted');
}

const CORE_CHECK_BUDGET = 1_000_000;

// Complete feasibility check used by the core minimizer. A PENDING outcome is
// treated as "not proven UNSAT" so the core stays a valid superset.
export function isUnsatObservations(obsList, limits) {
  if (structuralViolations(obsList, limits).length > 0) return true;
  const stars = buildStarTable(obsList, limits);
  const domains = new Map([...stars].map(([name, entry]) => [name, {
    coord: new Set(entry.domains.coord),
    mag: new Set(entry.domains.mag),
    cred: new Set(entry.domains.cred),
  }]));
  const budget = {
    propagation: { used: 0, limit: CORE_CHECK_BUDGET },
    backtracking: { used: 0, limit: CORE_CHECK_BUDGET },
  };
  try {
    search(domains, budget);
    return false;
  } catch (error) {
    if (error instanceof Conflict) return true;
    if (error instanceof BudgetExceeded) return false;
    throw error;
  }
}

// Deletion-based (1-minimal) UNSAT core over the active observations.
export function minimizeCore(obsList, limits) {
  let core = [...obsList];
  for (const obs of [...core]) {
    const trial = core.filter((candidate) => candidate !== obs);
    if (trial.length > 0 && isUnsatObservations(trial, limits)) core = trial;
  }
  return core;
}

function constraintsForCore(coreObs, limits) {
  const structural = structuralViolations(coreObs, limits);
  if (structural.length > 0) return structural;
  return [CONSTRAINT_EXCLUSIVE_ATTRIBUTION];
}

// Solve the catalog defined by the active observations.
// budgets: { propagation?: int, backtracking?: int }
// Returns one of:
//   { status: 'SAT', model, budget }
//   { status: 'UNSAT', coreObs, constraints, budget }
//   { status: 'PENDING', reason: 'BUDGET_EXCEEDED', exhausted, facts, budget }
export function solveObservations(obsList, limits, budgets = {}) {
  const budget = {
    propagation: { used: 0, limit: budgets.propagation ?? 100_000 },
    backtracking: { used: 0, limit: budgets.backtracking ?? 100_000 },
  };
  const reportBudget = () => ({
    propagation: { ...budget.propagation },
    backtracking: { ...budget.backtracking },
  });

  if (structuralViolations(obsList, limits).length > 0) {
    const coreObs = minimizeCore(obsList, limits);
    return {
      status: 'UNSAT',
      coreObs,
      constraints: constraintsForCore(coreObs, limits),
      budget: reportBudget(),
    };
  }

  const stars = buildStarTable(obsList, limits);
  const domains = new Map([...stars].map(([name, entry]) => [name, {
    coord: new Set(entry.domains.coord),
    mag: new Set(entry.domains.mag),
    cred: new Set(entry.domains.cred),
  }]));

  try {
    const model = search(domains, budget);
    return { status: 'SAT', model, budget: reportBudget() };
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return {
        status: 'PENDING',
        reason: 'BUDGET_EXCEEDED',
        exhausted: error.kind,
        facts: error.facts,
        budget: reportBudget(),
      };
    }
    if (error instanceof Conflict) {
      const coreObs = minimizeCore(obsList, limits);
      return {
        status: 'UNSAT',
        coreObs,
        constraints: constraintsForCore(coreObs, limits),
        budget: reportBudget(),
      };
    }
    throw error;
  }
}
