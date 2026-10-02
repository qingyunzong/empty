'use strict';

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.exitCode = 2;
  }
}

class UnknownRefError extends Error {
  constructor(unknowns) {
    super(
      'unknown reference(s): ' +
        unknowns.map((u) => `${u.kind} '${u.name}' (request ${u.requestId})`).join('; ')
    );
    this.name = 'UnknownRefError';
    this.exitCode = 3;
    this.unknowns = unknowns;
  }
}

class CycleError extends Error {
  constructor(kind, cycles) {
    super(
      `${kind} inheritance cycle(s) detected: ` +
        cycles.map((c) => c.join(' -> ')).join(' | ')
    );
    this.name = 'CycleError';
    this.exitCode = 4;
    this.kind = kind;
    this.cycles = cycles;
  }
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseTime(value, where) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new InputError(`invalid timestamp at ${where}: ${JSON.stringify(value)}`);
  }
  return Date.parse(value);
}

function validateHierarchy(raw, kind) {
  if (raw === undefined) return {};
  if (!isObj(raw)) throw new InputError(`${kind} must be an object`);
  const out = {};
  for (const [name, def] of Object.entries(raw)) {
    if (!isObj(def)) throw new InputError(`${kind}.${name} must be an object`);
    const inherits = def.inherits === undefined ? [] : def.inherits;
    if (!Array.isArray(inherits) || inherits.some((x) => typeof x !== 'string')) {
      throw new InputError(`${kind}.${name}.inherits must be an array of strings`);
    }
    out[name] = { inherits: inherits.slice() };
  }
  for (const [name, def] of Object.entries(out)) {
    for (const parent of def.inherits) {
      if (!out[parent]) {
        throw new InputError(`${kind}.${name} inherits from undefined ${kind} '${parent}'`);
      }
    }
  }
  return out;
}

function findCycles(graph) {
  const cycles = [];
  const state = new Map(); // 1 = on stack, 2 = done
  const stack = [];
  const reported = new Set();
  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      const s = state.get(next) || 0;
      if (s === 0) {
        dfs(next);
      } else if (s === 1) {
        const idx = stack.indexOf(next);
        const cycle = stack.slice(idx).concat(next);
        const key = cycle.slice(0, -1).sort().join('');
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    state.set(node, 2);
  }
  for (const node of graph.keys()) {
    if (!state.get(node)) dfs(node);
  }
  return cycles;
}

function distances(graph, starts) {
  const dist = new Map();
  const queue = [];
  for (const s of starts) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const parent of graph.get(cur) || []) {
      if (!dist.has(parent)) {
        dist.set(parent, dist.get(cur) + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

function pathTo(graph, starts, target) {
  const prev = new Map();
  const queue = [];
  for (const s of starts) {
    if (!prev.has(s)) {
      prev.set(s, null);
      queue.push(s);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    if (cur === target) {
      const path = [];
      for (let n = target; n !== null; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const parent of graph.get(cur) || []) {
      if (!prev.has(parent)) {
        prev.set(parent, cur);
        queue.push(parent);
      }
    }
  }
  return null;
}

function loadPolicies(raw) {
  if (!isObj(raw)) throw new InputError('policies must be a JSON object');

  const roles = validateHierarchy(raw.roles, 'roles');
  const zones = validateHierarchy(raw.zones, 'zones');

  const roleGraph = new Map(Object.entries(roles).map(([k, v]) => [k, v.inherits]));
  const zoneGraph = new Map(Object.entries(zones).map(([k, v]) => [k, v.inherits]));

  const roleCycles = findCycles(roleGraph);
  if (roleCycles.length) throw new CycleError('role', roleCycles);
  const zoneCycles = findCycles(zoneGraph);
  if (zoneCycles.length) throw new CycleError('zone', zoneCycles);

  const subjects = {};
  if (raw.subjects !== undefined) {
    if (!isObj(raw.subjects)) throw new InputError('subjects must be an object');
    for (const [name, def] of Object.entries(raw.subjects)) {
      if (!isObj(def) || !Array.isArray(def.roles) || def.roles.some((r) => typeof r !== 'string')) {
        throw new InputError(`subjects.${name}.roles must be an array of strings`);
      }
      for (const r of def.roles) {
        if (!roles[r]) throw new InputError(`subjects.${name} references undefined role '${r}'`);
      }
      subjects[name] = { roles: def.roles.slice() };
    }
  }

  const devices = {};
  if (raw.devices !== undefined) {
    if (!isObj(raw.devices)) throw new InputError('devices must be an object');
    for (const [name, def] of Object.entries(raw.devices)) {
      if (!isObj(def) || typeof def.zone !== 'string') {
        throw new InputError(`devices.${name}.zone must be a string`);
      }
      if (!zones[def.zone]) {
        throw new InputError(`devices.${name} references undefined zone '${def.zone}'`);
      }
      devices[name] = { zone: def.zone };
    }
  }

  if (!Array.isArray(raw.rules)) throw new InputError('rules must be an array');
  const rules = [];
  const seen = new Set();
  raw.rules.forEach((rule, i) => {
    const where = `rules[${i}]`;
    if (!isObj(rule)) throw new InputError(`${where} must be an object`);
    for (const f of ['id', 'action', 'effect']) {
      if (typeof rule[f] !== 'string') throw new InputError(`${where}.${f} must be a string`);
    }
    if (seen.has(rule.id)) throw new InputError(`duplicate rule id '${rule.id}'`);
    seen.add(rule.id);
    if (rule.effect !== 'allow' && rule.effect !== 'deny') {
      throw new InputError(`${where}.effect must be 'allow' or 'deny'`);
    }
    if (rule.role !== undefined && !roles[rule.role]) {
      throw new InputError(`${where} references undefined role '${rule.role}'`);
    }
    if (rule.zone !== undefined && !zones[rule.zone]) {
      throw new InputError(`${where} references undefined zone '${rule.zone}'`);
    }
    let window = null;
    if (rule.window !== undefined) {
      if (!isObj(rule.window)) throw new InputError(`${where}.window must be an object`);
      const start = parseTime(rule.window.start, `${where}.window.start`);
      const end = parseTime(rule.window.end, `${where}.window.end`);
      if (start > end) throw new InputError(`${where}.window start is after end`);
      window = { start: rule.window.start, end: rule.window.end };
    }
    let revokeAt = null;
    if (rule.revokeAt !== undefined && rule.revokeAt !== null) {
      parseTime(rule.revokeAt, `${where}.revokeAt`);
      revokeAt = rule.revokeAt;
    }
    const retroactive = rule.retroactive === undefined ? false : rule.retroactive;
    if (typeof retroactive !== 'boolean') {
      throw new InputError(`${where}.retroactive must be a boolean`);
    }
    rules.push({
      id: rule.id,
      action: rule.action,
      effect: rule.effect,
      role: rule.role === undefined ? null : rule.role,
      zone: rule.zone === undefined ? null : rule.zone,
      window,
      revokeAt,
      retroactive,
    });
  });

  return {
    raw: structuredClone(raw),
    roles,
    zones,
    subjects,
    devices,
    rules,
    roleGraph,
    zoneGraph,
  };
}

module.exports = {
  InputError,
  UnknownRefError,
  CycleError,
  loadPolicies,
  findCycles,
  distances,
  pathTo,
  parseTime,
};
