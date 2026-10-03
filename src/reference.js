'use strict';

// Naive reference: reduce the effective op log into a plain model, then
// evaluate every node from scratch. Used by tests to cross-check the
// incremental engine (values, invalid sets, certificates).

const { compute, buildSpecs } = require('./compute');
const { createModel, applyToModel } = require('./model');

function reduceOps(ops) {
  const model = createModel();
  for (const op of ops) applyToModel(model, op);
  return model;
}

function evaluateAll(model) {
  const specs = buildSpecs(model);
  const states = new Map();
  const visit = (id) => {
    if (states.has(id)) return states.get(id);
    const spec = specs.get(id);
    const depStates = new Map(spec.deps.map((d) => [d, visit(d)]));
    const st = compute(spec, depStates);
    states.set(id, st);
    return st;
  };
  for (const id of [...specs.keys()].sort()) visit(id);
  return states;
}

function snapshotFrom(states) {
  const values = {};
  const invalid = [];
  const errors = {};
  for (const id of [...states.keys()].sort()) {
    const st = states.get(id);
    values[id] = st;
    if (st.invalid) invalid.push(id);
    if (st.error) errors[id] = st.reason;
  }
  return { values, invalid, errors };
}

// changed-map with the same convention as engine certificates:
// id -> new state, or null when the node no longer exists.
function diffStates(before, after) {
  const changed = {};
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of [...ids].sort()) {
    const a = before.get(id);
    const b = after.get(id);
    if (b === undefined) changed[id] = null;
    else if (a === undefined || JSON.stringify(a) !== JSON.stringify(b)) changed[id] = b;
  }
  return changed;
}

module.exports = { reduceOps, evaluateAll, snapshotFrom, diffStates };
