import { invalidInput } from './errors.js';

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function isPosInt(v) {
  return Number.isInteger(v) && v >= 1;
}

// Validate and normalize an experiment instance. Throws INVALID_INPUT.
// Instance shape:
// {
//   machines: int >= 1,
//   memoryLimit: int >= 0,
//   steps: [{ id, params: [str...], memory: int >= 0, duration: int >= 1 }],
//   edges: [[from, to]...],
//   compat: [{ between: [a, b], allow: [[pa, pb]...] }...]
// }
export function validateInstance(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidInput('instance must be an object');
  }
  const inst = {
    machines: raw.machines,
    memoryLimit: raw.memoryLimit,
    steps: raw.steps,
    edges: raw.edges === undefined ? [] : raw.edges,
    compat: raw.compat === undefined ? [] : raw.compat,
  };
  if (!isPosInt(inst.machines)) errors.push('machines must be an integer >= 1');
  if (!isNonNegInt(inst.memoryLimit)) errors.push('memoryLimit must be an integer >= 0');
  if (!Array.isArray(inst.steps) || inst.steps.length === 0) {
    errors.push('steps must be a non-empty array');
  }
  if (errors.length) throw invalidInput('invalid instance', errors);

  const ids = new Set();
  const steps = [];
  for (const [i, s] of inst.steps.entries()) {
    const where = `steps[${i}]`;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof s.id !== 'string' || s.id.length === 0) errors.push(`${where}.id must be a non-empty string`);
    else if (ids.has(s.id)) errors.push(`duplicate step id ${JSON.stringify(s.id)}`);
    else ids.add(s.id);
    if (!Array.isArray(s.params) || s.params.length === 0 || !s.params.every((p) => typeof p === 'string')) {
      errors.push(`${where}.params must be a non-empty array of strings`);
    } else if (new Set(s.params).size !== s.params.length) {
      errors.push(`${where}.params must not contain duplicates`);
    }
    if (!isNonNegInt(s.memory)) errors.push(`${where}.memory must be an integer >= 0`);
    if (!isPosInt(s.duration)) errors.push(`${where}.duration must be an integer >= 1`);
    steps.push({ id: s.id, params: [...s.params], memory: s.memory, duration: s.duration });
  }

  const edges = [];
  if (!Array.isArray(inst.edges)) {
    errors.push('edges must be an array');
  } else {
    const seen = new Set();
    for (const [i, e] of inst.edges.entries()) {
      const where = `edges[${i}]`;
      if (!Array.isArray(e) || e.length !== 2 || !e.every((x) => typeof x === 'string')) {
        errors.push(`${where} must be a [from, to] pair of strings`);
        continue;
      }
      const [a, b] = e;
      if (!ids.has(a) || !ids.has(b)) errors.push(`${where} references unknown step`);
      else if (a === b) errors.push(`${where} is a self edge`);
      else {
        const key = a + '' + b;
        if (seen.has(key)) errors.push(`duplicate edge ${JSON.stringify(e)}`);
        seen.add(key);
        edges.push([a, b]);
      }
    }
  }

  const paramOf = new Map(steps.map((s) => [s.id, new Set(s.params)]));
  const compat = [];
  if (!Array.isArray(inst.compat)) {
    errors.push('compat must be an array');
  } else {
    for (const [i, c] of inst.compat.entries()) {
      const where = `compat[${i}]`;
      if (c === null || typeof c !== 'object' || !Array.isArray(c.between) || c.between.length !== 2) {
        errors.push(`${where}.between must be a pair of step ids`);
        continue;
      }
      const [a, b] = c.between;
      if (!ids.has(a) || !ids.has(b)) {
        errors.push(`${where}.between references unknown step`);
        continue;
      }
      if (a === b) {
        errors.push(`${where}.between must reference two distinct steps`);
        continue;
      }
      if (!Array.isArray(c.allow)) {
        errors.push(`${where}.allow must be an array of [paramA, paramB] pairs`);
        continue;
      }
      const allow = [];
      let ok = true;
      for (const [j, pair] of c.allow.entries()) {
        if (!Array.isArray(pair) || pair.length !== 2 ||
            !paramOf.get(a).has(pair[0]) || !paramOf.get(b).has(pair[1])) {
          errors.push(`${where}.allow[${j}] is not a valid (param of ${a}, param of ${b}) pair`);
          ok = false;
          continue;
        }
        allow.push([pair[0], pair[1]]);
      }
      if (ok) compat.push({ between: [a, b], allow });
    }
  }

  // Acyclicity check (Kahn).
  if (errors.length === 0) {
    const indeg = new Map(steps.map((s) => [s.id, 0]));
    const adj = new Map(steps.map((s) => [s.id, []]));
    for (const [a, b] of edges) {
      adj.get(a).push(b);
      indeg.set(b, indeg.get(b) + 1);
    }
    const queue = [...ids].filter((id) => indeg.get(id) === 0);
    let seen = 0;
    while (queue.length) {
      const u = queue.pop();
      seen++;
      for (const v of adj.get(u)) {
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) queue.push(v);
      }
    }
    if (seen !== ids.size) errors.push('edges contain a cycle');
  }

  if (errors.length) throw invalidInput('invalid instance', errors);

  return {
    machines: inst.machines,
    memoryLimit: inst.memoryLimit,
    steps,
    edges,
    compat,
  };
}

// Derived index structures shared by solver and brute force.
export function indexInstance(inst) {
  const byId = new Map(inst.steps.map((s) => [s.id, s]));
  const preds = new Map(inst.steps.map((s) => [s.id, []]));
  const succs = new Map(inst.steps.map((s) => [s.id, []]));
  for (const [a, b] of inst.edges) {
    preds.get(b).push(a);
    succs.get(a).push(b);
  }
  // Deterministic topological order (lexicographic Kahn).
  const indeg = new Map(inst.steps.map((s) => [s.id, preds.get(s.id).length]));
  const ready = inst.steps.map((s) => s.id).filter((id) => indeg.get(id) === 0).sort();
  const topo = [];
  while (ready.length) {
    const u = ready.shift();
    topo.push(u);
    for (const v of succs.get(u).slice().sort()) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) {
        const at = ready.findIndex((x) => x > v);
        if (at === -1) ready.push(v);
        else ready.splice(at, 0, v);
      }
    }
  }
  // Compat adjacency: id -> [{ other, allow, firstIsSelf }]
  const compatAdj = new Map(inst.steps.map((s) => [s.id, []]));
  for (const c of inst.compat) {
    const [a, b] = c.between;
    compatAdj.get(a).push({ other: b, allow: c.allow, firstIsSelf: true });
    compatAdj.get(b).push({ other: a, allow: c.allow, firstIsSelf: false });
  }
  for (const list of compatAdj.values()) {
    list.sort((x, y) => (x.other < y.other ? -1 : x.other > y.other ? 1 : 0));
  }
  return { byId, preds, succs, topo, compatAdj };
}
