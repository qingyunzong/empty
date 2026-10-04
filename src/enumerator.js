// Built-in brute-force enumerator: independent ground truth used by the
// test-suite to cross-check the solver on small instances (n <= 9 events).
import { nightStarKey, cellId } from './model.js';
import { groupByNight } from './solver.js';

const MAX_MODELS = 4096;

// Recompute domains from scratch (independent of the incremental updates in
// model.js) so tests can verify incremental maintenance state by state.
export function recomputeDomains(state) {
  const domains = {};
  for (const id of state.order) {
    const o = state.obs[id];
    if (!o.active) continue;
    const key = nightStarKey(o.night, o.star);
    const cell = cellId(state.config, o.coord, o.mag);
    const dom = (domains[key] ??= {});
    (dom[cell] ??= []).push(id);
  }
  return domains;
}

export function canonicalCells(cells) {
  const nights = Object.keys(cells).map(Number).sort((a, b) => a - b);
  const parts = [];
  for (const n of nights) {
    const stars = Object.keys(cells[n]).sort();
    parts.push(`${n}:{${stars.map((s) => `${s}=${cells[n][s]}`).join(',')}}`);
  }
  return parts.join('|');
}

export function enumerateCatalog(state) {
  // time_order
  const byStar = new Map();
  for (const id of state.order) {
    const o = state.obs[id];
    if (!o.active) continue;
    if (!byStar.has(o.star)) byStar.set(o.star, []);
    byStar.get(o.star).push(o);
  }
  for (const list of byStar.values()) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].ts < list[i - 1].ts) return { status: 'UNSAT', models: [] };
    }
  }
  // unique_key
  for (const key of Object.keys(state.domains)) {
    for (const cell of Object.keys(state.domains[key])) {
      if (state.domains[key][cell].length > 1) return { status: 'UNSAT', models: [] };
    }
  }
  // exclusive_cell + night_capacity, enumerated per night
  let models = [{}];
  for (const [night, stars] of groupByNight(state)) {
    if (stars.length > state.config.capacity) return { status: 'UNSAT', models: [] };
    const doms = stars.map((s) => Object.keys(state.domains[nightStarKey(night, s)]).map(Number));
    const nightAssigns = [];
    const assign = new Array(stars.length);
    const used = new Set();
    const rec = (i) => {
      if (nightAssigns.length >= MAX_MODELS) return;
      if (i === stars.length) {
        nightAssigns.push([...assign]);
        return;
      }
      for (const c of doms[i]) {
        if (used.has(c)) continue;
        used.add(c);
        assign[i] = c;
        rec(i + 1);
        used.delete(c);
      }
    };
    rec(0);
    if (nightAssigns.length === 0) return { status: 'UNSAT', models: [] };
    const next = [];
    for (const m of models) {
      for (const na of nightAssigns) {
        next.push({ ...m, [night]: Object.fromEntries(stars.map((s, i) => [s, na[i]])) });
        if (next.length >= MAX_MODELS) break;
      }
      if (next.length >= MAX_MODELS) break;
    }
    models = next;
  }
  return { status: 'SAT', models: models.map(canonicalCells) };
}
