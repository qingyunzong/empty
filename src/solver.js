// Finite-domain solver: propagation (singleton assignment + all-different
// pruning + Hall check) with chronological backtracking.
// Budgets are charged separately per propagation step and per backtrack node;
// exhausting either raises BudgetExceeded -> PENDING (never UNSAT), keeping
// the facts propagated so far.
import { nightStarKey, cellId, cellCoord, cellMag, applyRetract } from './model.js';

export class BudgetExceeded extends Error {
  constructor(kind, partial) {
    super(`BUDGET_EXCEEDED:${kind}`);
    this.name = 'BudgetExceeded';
    this.kind = kind;
    this.partial = partial;
  }
}

export const DEFAULT_BUDGET = Object.freeze({ propagation: 100_000, backtrack: 10_000 });
export const UNLIMITED_BUDGET = Object.freeze({ propagation: 50_000_000, backtrack: 5_000_000 });

const uniq = (arr) => [...new Set(arr)];
const sortedNums = (arr) => [...arr].sort((a, b) => a - b);

function activeObsList(state) {
  const out = [];
  for (const id of state.order) {
    const o = state.obs[id];
    if (o.active) out.push(o);
  }
  return out;
}

export function groupByNight(state) {
  const nights = new Map();
  for (const key of Object.keys(state.domains)) {
    const sep = key.indexOf('');
    const night = Number(key.slice(0, sep));
    const star = key.slice(sep + 1);
    if (!nights.has(night)) nights.set(night, []);
    nights.get(night).push(star);
  }
  for (const stars of nights.values()) stars.sort();
  return [...nights.entries()].sort((a, b) => a[0] - b[0]);
}

function nightStarEvents(state, night, star) {
  const dom = state.domains[nightStarKey(night, star)] ?? {};
  return uniq(Object.values(dom).flat().flatMap((id) => state.obs[id].events));
}

function cellEvents(state, night, star, cell) {
  const ids = state.domains[nightStarKey(night, star)]?.[cell] ?? [];
  return uniq(ids.flatMap((id) => state.obs[id].events));
}

function cellMaxConf(state, night, star, cell) {
  const ids = state.domains[nightStarKey(night, star)]?.[cell] ?? [];
  let best = -1;
  for (const id of ids) best = Math.max(best, state.obs[id].conf);
  return best;
}

function snapshotPartial(night, stars, domains, assignment) {
  return {
    night,
    assignments: { ...assignment },
    domains: Object.fromEntries(stars.map((s) => [s, [...domains[s]].sort((a, b) => a - b)])),
  };
}

// Hard constraints checked once per solve (charged as propagation steps):
//  - time_order: per star, ts is non-decreasing in event order.
//  - unique_key: per (night, star, cell) at most one active observation.
function checkStatic(state, charge, explanation) {
  const byStar = new Map();
  for (const o of activeObsList(state)) {
    if (!byStar.has(o.star)) byStar.set(o.star, []);
    byStar.get(o.star).push(o);
  }
  for (const star of [...byStar.keys()].sort()) {
    const list = byStar.get(star);
    for (let i = 1; i < list.length; i++) {
      charge('propagation', { phase: 'static', constraint: 'time_order' });
      if (list[i].ts < list[i - 1].ts) {
        const events = uniq([...list[i - 1].events, ...list[i].events]).sort((a, b) => a - b);
        explanation.push({ kind: 'conflict', constraint: 'time_order', star, obs: [list[i - 1].id, list[i].id], events });
        return { constraint: 'time_order', star, obs: [list[i - 1].id, list[i].id], events };
      }
    }
  }
  for (const key of Object.keys(state.domains).sort()) {
    const dom = state.domains[key];
    const sep = key.indexOf('');
    const night = Number(key.slice(0, sep));
    const star = key.slice(sep + 1);
    for (const cell of Object.keys(dom).sort((a, b) => a - b)) {
      charge('propagation', { phase: 'static', constraint: 'unique_key' });
      if (dom[cell].length > 1) {
        const events = uniq(dom[cell].flatMap((id) => state.obs[id].events)).sort((a, b) => a - b);
        explanation.push({ kind: 'conflict', constraint: 'unique_key', star, night, cell: Number(cell), events });
        return { constraint: 'unique_key', star, night, obs: [...dom[cell]], events };
      }
    }
  }
  return null;
}

function solveNight(state, night, stars, charge, explanation) {
  charge('propagation', { phase: 'capacity', night });
  if (stars.length > state.config.capacity) {
    const events = uniq(stars.flatMap((s) => nightStarEvents(state, night, s))).sort((a, b) => a - b);
    explanation.push({ kind: 'conflict', constraint: 'night_capacity', night, events });
    return { conflict: { constraint: 'night_capacity', night, events } };
  }
  const domains = {};
  for (const s of stars) {
    domains[s] = new Set(Object.keys(state.domains[nightStarKey(night, s)]).map(Number));
  }
  return search(state, night, stars, domains, {}, charge, explanation);
}

function search(state, night, stars, domains, assignment, charge, explanation) {
  // Propagation: singleton domains force assignments and prune peers.
  const queue = [];
  for (const s of stars) {
    if (!(s in assignment) && domains[s].size === 1) queue.push(s);
  }
  while (queue.length > 0) {
    const s = queue.shift();
    if (s in assignment) continue;
    const cell = [...domains[s]][0];
    charge('propagation', snapshotPartial(night, stars, domains, assignment));
    assignment[s] = cell;
    explanation.push({ kind: 'assign', night, star: s, cell, events: cellEvents(state, night, s, cell) });
    for (const t of stars) {
      if (t === s || t in assignment || !domains[t].has(cell)) continue;
      charge('propagation', snapshotPartial(night, stars, domains, assignment));
      domains[t].delete(cell);
      explanation.push({
        kind: 'prune', night, star: t, cell, constraint: 'exclusive_cell',
        cause: { star: s, events: cellEvents(state, night, s, cell) },
      });
      if (domains[t].size === 0) {
        const events = uniq([...nightStarEvents(state, night, t), ...nightStarEvents(state, night, s)]).sort((a, b) => a - b);
        explanation.push({ kind: 'conflict', constraint: 'exclusive_cell', night, star: t, events });
        return { conflict: { constraint: 'exclusive_cell', night, events } };
      }
      if (domains[t].size === 1) queue.push(t);
    }
  }
  // Hall check: union of remaining domains must cover the unassigned stars.
  const unassigned = stars.filter((s) => !(s in assignment));
  charge('propagation', snapshotPartial(night, stars, domains, assignment));
  const union = new Set();
  for (const s of unassigned) for (const c of domains[s]) union.add(c);
  if (union.size < unassigned.length) {
    const events = uniq(unassigned.flatMap((s) => nightStarEvents(state, night, s))).sort((a, b) => a - b);
    explanation.push({ kind: 'conflict', constraint: 'exclusive_cell', night, detail: 'hall_violation', events });
    return { conflict: { constraint: 'exclusive_cell', night, events } };
  }
  if (unassigned.length === 0) return { assignment };
  // Backtracking: MRV variable, values ordered by confidence desc then cell asc.
  let pick = unassigned[0];
  for (const s of unassigned) if (domains[s].size < domains[pick].size) pick = s;
  const values = [...domains[pick]].sort((a, b) => {
    const d = cellMaxConf(state, night, pick, b) - cellMaxConf(state, night, pick, a);
    return d !== 0 ? d : a - b;
  });
  const subConflicts = [];
  for (const value of values) {
    charge('backtrack', snapshotPartial(night, stars, domains, assignment));
    const branchDomains = {};
    for (const s of stars) branchDomains[s] = new Set(domains[s]);
    branchDomains[pick] = new Set([value]);
    explanation.push({ kind: 'branch', night, star: pick, cell: value, events: cellEvents(state, night, pick, value) });
    const r = search(state, night, stars, branchDomains, { ...assignment }, charge, explanation);
    if (!r.conflict) return r;
    subConflicts.push(r.conflict);
  }
  const events = uniq(subConflicts.flatMap((c) => c.events)).sort((a, b) => a - b);
  return { conflict: { constraint: 'exclusive_cell', night, events } };
}

function buildModel(state, assignments) {
  const model = {};
  const superseded = [];
  for (const [night, assign] of assignments) {
    const m = {};
    for (const star of Object.keys(assign).sort()) {
      const cell = assign[star];
      const ids = state.domains[nightStarKey(night, star)][cell];
      let best = null;
      for (const id of ids) {
        const o = state.obs[id];
        if (!best || o.conf > best.conf
          || (o.conf === best.conf && state.order.indexOf(id) < state.order.indexOf(best.id))) {
          best = o;
        }
      }
      m[star] = {
        cell,
        coord: cellCoord(state.config, cell),
        mag: cellMag(state.config, cell),
        obs: best.id,
        conf: best.conf,
      };
    }
    model[night] = m;
  }
  for (const o of activeObsList(state)) {
    const assign = assignments.get(o.night);
    const cell = cellId(state.config, o.coord, o.mag);
    if (!assign || assign[o.star] !== cell) {
      superseded.push({ obs: o.id, star: o.star, night: o.night, cell, reason: 'cell_not_selected' });
    }
  }
  return { model, superseded };
}

function cellsOfModel(model) {
  const cells = {};
  for (const [night, stars] of Object.entries(model)) {
    cells[night] = {};
    for (const [star, info] of Object.entries(stars)) cells[night][star] = info.cell;
  }
  return cells;
}

export function solveCatalog(state, budget = DEFAULT_BUDGET, opts = {}) {
  const withCore = opts.withCore !== false;
  const stats = { propagation: 0, backtrack: 0 };
  const remaining = { propagation: budget.propagation, backtrack: budget.backtrack };
  const explanation = [];
  const completedNights = {};
  const charge = (kind, partial) => {
    if (remaining[kind] <= 0) throw new BudgetExceeded(kind, partial ?? null);
    remaining[kind] -= 1;
    stats[kind] += 1;
  };
  try {
    const staticConflict = checkStatic(state, charge, explanation);
    if (staticConflict) return finishUnsat(state, staticConflict, stats, remaining, explanation, withCore);
    const assignments = new Map();
    for (const [night, stars] of groupByNight(state)) {
      const r = solveNight(state, night, stars, charge, explanation);
      if (r.conflict) return finishUnsat(state, r.conflict, stats, remaining, explanation, withCore);
      assignments.set(night, r.assignment);
      completedNights[night] = { ...r.assignment };
    }
    const { model, superseded } = buildModel(state, assignments);
    return { status: 'SAT', model, cells: cellsOfModel(model), superseded, stats, remaining, explanation };
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return {
        status: 'PENDING',
        reason: 'BUDGET_EXCEEDED',
        exceeded: err.kind,
        partial: { completedNights, inProgress: err.partial },
        stats,
        remaining,
        explanation,
      };
    }
    throw err;
  }
}

function finishUnsat(state, conflict, stats, remaining, explanation, withCore) {
  const out = { status: 'UNSAT', conflict, stats, remaining, explanation };
  if (withCore) out.unsatCore = minimizeCore(state, conflict);
  return out;
}

// Deletion-minimal UNSAT core over observation-contributing events:
// the smallest subset of the conflicting scope whose observations alone are
// still UNSAT. `events` are event-log indices (add_obs / correct_obs).
export function minimizeCore(state, conflict) {
  let candidates;
  if (conflict.constraint === 'time_order') {
    candidates = activeObsList(state).filter((o) => o.star === conflict.star).map((o) => o.id);
  } else if (conflict.constraint === 'unique_key') {
    candidates = [...conflict.obs];
  } else {
    candidates = activeObsList(state).filter((o) => o.night === conflict.night).map((o) => o.id);
  }
  const statusWith = (keep) => {
    const trial = structuredClone(state);
    for (const id of Object.keys(trial.obs)) {
      if (trial.obs[id].active && !keep.has(id)) applyRetract(trial, id);
    }
    return solveCatalog(trial, UNLIMITED_BUDGET, { withCore: false });
  };
  let core = [...candidates];
  for (const id of candidates) {
    if (!core.includes(id)) continue;
    const keep = new Set(core.filter((x) => x !== id));
    if (statusWith(keep).status === 'UNSAT') core = core.filter((x) => x !== id);
  }
  const finalRun = statusWith(new Set(core));
  const constraints = uniq([conflict.constraint, finalRun.conflict?.constraint].filter(Boolean));
  const events = sortedNums(uniq(core.flatMap((id) => state.obs[id].events)));
  return { events, obs: [...core].sort(), constraints };
}
