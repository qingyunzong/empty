import { canon, sha256 } from "./canon.js";

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function normalizeStep(raw) {
  if (!isObj(raw)) throw new InputError("each step must be an object");
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new InputError("step.id must be a non-empty string");
  }
  if (!Array.isArray(raw.params) || raw.params.length === 0) {
    throw new InputError(`step "${raw.id}" params must be a non-empty array`);
  }
  const params = [];
  for (const p of raw.params) {
    if (typeof p !== "string" || p.length === 0) {
      throw new InputError(`step "${raw.id}" params must be non-empty strings`);
    }
    if (params.includes(p)) {
      throw new InputError(`step "${raw.id}" has duplicate param "${p}"`);
    }
    params.push(p);
  }
  params.sort();
  if (!Number.isInteger(raw.memory) || raw.memory < 0) {
    throw new InputError(`step "${raw.id}" memory must be an integer >= 0`);
  }
  const duration = raw.duration === undefined ? 1 : raw.duration;
  if (!Number.isInteger(duration) || duration < 1) {
    throw new InputError(`step "${raw.id}" duration must be an integer >= 1`);
  }
  return { id: raw.id, params, memory: raw.memory, duration };
}

function normalizeEdges(rawEdges, stepMap) {
  if (!Array.isArray(rawEdges)) throw new InputError("spec.edges must be an array");
  const edgeSet = new Set();
  const edges = [];
  for (const e of rawEdges) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "string") {
      throw new InputError("each edge must be a [from, to] pair of step ids");
    }
    const [u, v] = e;
    if (!stepMap.has(u)) throw new InputError(`edge references unknown step "${u}"`);
    if (!stepMap.has(v)) throw new InputError(`edge references unknown step "${v}"`);
    if (u === v) throw new InputError(`self edge "${u}" is not allowed`);
    const key = u + ">" + v;
    if (edgeSet.has(key)) throw new InputError(`duplicate edge "${key}"`);
    edgeSet.add(key);
    edges.push([u, v]);
  }
  edges.sort((a, b) => (a[0] + ">" + a[1] < b[0] + ">" + b[1] ? -1 : 1));
  return { edges, edgeSet };
}

function normalizeCompat(rawCompat, edgeSet, stepMap) {
  if (!isObj(rawCompat)) throw new InputError("spec.compat must be an object");
  const compat = new Map();
  for (const [key, table] of Object.entries(rawCompat)) {
    if (!edgeSet.has(key)) {
      throw new InputError(`compat key "${key}" does not match an edge "from>to"`);
    }
    if (!isObj(table)) throw new InputError(`compat["${key}"] must be an object`);
    const [u, v] = key.split(">");
    const uParams = stepMap.get(u).params;
    const vParams = stepMap.get(v).params;
    for (const k of Object.keys(table)) {
      if (!uParams.includes(k)) {
        throw new InputError(`compat["${key}"] uses unknown param "${k}" of step "${u}"`);
      }
    }
    const m = new Map();
    for (const pu of uParams) {
      const row = table[pu];
      let allowed;
      if (row === undefined) {
        allowed = [...vParams];
      } else {
        if (!Array.isArray(row)) throw new InputError(`compat["${key}"]["${pu}"] must be an array`);
        allowed = [];
        for (const pv of row) {
          if (!vParams.includes(pv)) {
            throw new InputError(`compat["${key}"]["${pu}"] names unknown param "${pv}" of step "${v}"`);
          }
          if (!allowed.includes(pv)) allowed.push(pv);
        }
        allowed.sort();
      }
      m.set(pu, allowed);
    }
    compat.set(key, m);
  }
  return compat;
}

function normalizeMutex(rawMutex, stepMap, index) {
  if (!Array.isArray(rawMutex)) throw new InputError("spec.mutex must be an array");
  const seen = new Set();
  const mutex = [];
  for (const pr of rawMutex) {
    if (!Array.isArray(pr) || pr.length !== 2 || typeof pr[0] !== "string" || typeof pr[1] !== "string") {
      throw new InputError("each mutex entry must be a [a, b] pair of step ids");
    }
    const [a, b] = pr;
    if (!stepMap.has(a)) throw new InputError(`mutex references unknown step "${a}"`);
    if (!stepMap.has(b)) throw new InputError(`mutex references unknown step "${b}"`);
    if (a === b) throw new InputError(`mutex self pair "${a}" is not allowed`);
    const key = a < b ? a + ">" + b : b + ">" + a;
    if (seen.has(key)) throw new InputError(`duplicate mutex pair "${key}"`);
    seen.add(key);
    mutex.push([index.get(a), index.get(b)]);
  }
  return mutex;
}

export function normalizeSpec(raw) {
  if (!isObj(raw)) throw new InputError("spec must be a JSON object");
  const { machines, memoryLimit } = raw;
  if (!Number.isInteger(machines) || machines < 1) {
    throw new InputError("spec.machines must be an integer >= 1");
  }
  if (!Number.isInteger(memoryLimit) || memoryLimit < 0) {
    throw new InputError("spec.memoryLimit must be an integer >= 0");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new InputError("spec.steps must be a non-empty array");
  }
  const stepMap = new Map();
  for (const s of raw.steps) {
    const step = normalizeStep(s);
    if (stepMap.has(step.id)) throw new InputError(`duplicate step id "${step.id}"`);
    stepMap.set(step.id, step);
  }
  const steps = [...stepMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const { edges, edgeSet } = normalizeEdges(raw.edges ?? [], stepMap);
  const compat = normalizeCompat(raw.compat ?? {}, edgeSet, stepMap);
  for (const [u, v] of edges) {
    const key = u + ">" + v;
    if (!compat.has(key)) {
      const m = new Map();
      for (const pu of stepMap.get(u).params) m.set(pu, [...stepMap.get(v).params]);
      compat.set(key, m);
    }
  }
  const mutex = normalizeMutex(raw.mutex ?? [], stepMap, index);

  const succ = steps.map(() => []);
  const pred = steps.map(() => []);
  for (const [u, v] of edges) {
    succ[index.get(u)].push(index.get(v));
    pred[index.get(v)].push(index.get(u));
  }
  const indeg = steps.map((_, i) => pred[i].length);
  const ready = [];
  for (let i = 0; i < steps.length; i++) if (indeg[i] === 0) ready.push(i);
  const topo = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const u = ready.shift();
    topo.push(u);
    for (const v of succ[u]) if (--indeg[v] === 0) ready.push(v);
  }
  if (topo.length !== steps.length) throw new InputError("dependency graph contains a cycle");

  const totalDur = steps.reduce((a, s) => a + s.duration, 0);
  const estSrc = new Array(steps.length).fill(0);
  for (const u of topo) {
    for (const v of succ[u]) estSrc[v] = Math.max(estSrc[v], estSrc[u] + steps[u].duration);
  }
  const critPath = Math.max(...estSrc.map((e, i) => e + steps[i].duration));

  return { machines, memoryLimit, steps, index, edges, edgeSet, compat, mutex, succ, pred, topo, totalDur, critPath };
}

export function plainSpec(norm) {
  const compat = {};
  for (const [key, m] of [...norm.compat.entries()].sort()) {
    compat[key] = Object.fromEntries([...m.entries()].sort());
  }
  return {
    machines: norm.machines,
    memoryLimit: norm.memoryLimit,
    steps: norm.steps.map((s) => ({ id: s.id, params: s.params, memory: s.memory, duration: s.duration })),
    edges: norm.edges,
    compat,
    mutex: norm.mutex.map(([a, b]) => [norm.steps[a].id, norm.steps[b].id].sort()),
  };
}

export function specHashOf(norm) {
  return sha256(canon(plainSpec(norm)));
}
