'use strict';

// Node model for the plate QC dependency graph.
// Node ids:
//   well:<plate>:<well>     raw absorbance (source)
//   negCtrl:<plate>         negative control absorbance
//   posCtrl:<plate>         positive control absorbance
//   corr:<plate>:<well>     negative-corrected absorbance
//   ratio:<plate>:<well>    absorbance / positive control
//   plateMean:<plate>       mean of corrected values on the plate
//   repMean:<group>         mean of corrected values of member wells
//   repCV:<group>           coefficient of variation of member wells
// Replicate groups reference wells as "<plate>/<well>".

const ID_RE = /^[A-Za-z0-9_.-]+$/;
const E_QC = 'E_QC';

// Dependencies always point from a lower rank to a higher rank, so sorting
// dirty nodes by (rank, id) yields a valid recomputation order.
const RANK = Object.freeze({
  well: 0,
  negCtrl: 1,
  posCtrl: 1,
  corr: 2,
  ratio: 2,
  plateMean: 3,
  repMean: 3,
  repCV: 4,
});

const ERR = Object.freeze({ value: null, error: E_QC, invalid: false });
const INVALID = Object.freeze({ value: null, error: null, invalid: true });

function ok(value) {
  return { value, error: null, invalid: false };
}

function kindOf(id) {
  return id.slice(0, id.indexOf(':'));
}

function corrIdForRef(ref) {
  return 'corr:' + ref.replace('/', ':');
}

function byRankThenId(a, b) {
  const d = RANK[kindOf(a)] - RANK[kindOf(b)];
  return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
}

function listNodes(state) {
  const ids = [];
  for (const [plate, p] of state.plates) {
    ids.push(`negCtrl:${plate}`, `posCtrl:${plate}`, `plateMean:${plate}`);
    for (const well of p.wells.keys()) {
      ids.push(`well:${plate}:${well}`, `corr:${plate}:${well}`, `ratio:${plate}:${well}`);
    }
  }
  for (const group of state.reps.keys()) {
    ids.push(`repMean:${group}`, `repCV:${group}`);
  }
  return ids.sort();
}

function depsOf(id, state) {
  const [kind, a, b] = id.split(':');
  switch (kind) {
    case 'well':
      return [];
    case 'negCtrl':
    case 'posCtrl': {
      const p = state.plates.get(a);
      const target = kind === 'negCtrl' ? p.neg : p.pos;
      return target != null && p.wells.has(target) ? [`well:${a}:${target}`] : [];
    }
    case 'corr':
      return [`well:${a}:${b}`, `negCtrl:${a}`];
    case 'ratio':
      return [`well:${a}:${b}`, `posCtrl:${a}`];
    case 'plateMean': {
      const p = state.plates.get(a);
      return [...p.wells.keys()].sort().map((w) => `corr:${a}:${w}`);
    }
    case 'repMean':
      return [...state.reps.get(a)].sort().map(corrIdForRef);
    case 'repCV':
      return [`repMean:${a}`, ...[...state.reps.get(a)].sort().map(corrIdForRef)];
    default:
      throw new Error(`unknown node kind: ${id}`);
  }
}

// Collect corrected values for a replicate group's well refs, in sorted
// order for deterministic floating-point summation.
function refValues(state, refs, get) {
  const vals = [];
  for (const ref of [...refs].sort()) {
    const [plate, well] = ref.split('/');
    const p = state.plates.get(plate);
    if (!p || !p.wells.has(well)) return { error: true };
    const c = get(corrIdForRef(ref));
    if (c.error) return { error: true };
    vals.push(c.value);
  }
  return { vals };
}

function computeNode(id, state, get) {
  const [kind, a, b] = id.split(':');
  switch (kind) {
    case 'well':
      return ok(state.plates.get(a).wells.get(b));
    case 'negCtrl':
    case 'posCtrl': {
      const p = state.plates.get(a);
      const target = kind === 'negCtrl' ? p.neg : p.pos;
      if (target == null || !p.wells.has(target)) return ERR;
      return ok(get(`well:${a}:${target}`).value);
    }
    case 'corr': {
      const neg = get(`negCtrl:${a}`);
      if (neg.error) return ERR;
      return ok(get(`well:${a}:${b}`).value - neg.value);
    }
    case 'ratio': {
      const pos = get(`posCtrl:${a}`);
      if (pos.error) return ERR;
      if (pos.value === 0) return INVALID;
      return ok(get(`well:${a}:${b}`).value / pos.value);
    }
    case 'plateMean': {
      const p = state.plates.get(a);
      if (p.wells.size === 0) return ERR;
      let sum = 0;
      for (const w of [...p.wells.keys()].sort()) {
        const c = get(`corr:${a}:${w}`);
        if (c.error) return ERR;
        sum += c.value;
      }
      return ok(sum / p.wells.size);
    }
    case 'repMean': {
      const refs = state.reps.get(a);
      if (refs.length === 0) return ERR;
      const { vals, error } = refValues(state, refs, get);
      if (error) return ERR;
      return ok(vals.reduce((s, x) => s + x, 0) / vals.length);
    }
    case 'repCV': {
      const refs = state.reps.get(a);
      if (refs.length === 0) return ERR;
      const mean = get(`repMean:${a}`);
      if (mean.error) return ERR;
      const { vals, error } = refValues(state, refs, get);
      if (error) return ERR;
      if (mean.value === 0) return INVALID;
      const variance = vals.reduce((s, x) => s + (x - mean.value) ** 2, 0) / vals.length;
      return ok(Math.sqrt(variance) / mean.value);
    }
    default:
      throw new Error(`unknown node kind: ${id}`);
  }
}

module.exports = {
  ID_RE,
  E_QC,
  RANK,
  ERR,
  INVALID,
  ok,
  kindOf,
  corrIdForRef,
  byRankThenId,
  listNodes,
  depsOf,
  computeNode,
};
