import { ruleCycle, badInput } from './errors.js';

const RULE_TYPES = new Set(['range', 'eq', 'neq', 'sum_lte', 'sum_gte']);

export function validateRules(rules) {
  if (!Array.isArray(rules)) throw badInput('rules must be an array');
  const ids = new Set();
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string') throw badInput('every rule needs a string id');
    if (ids.has(rule.id)) throw badInput(`duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!RULE_TYPES.has(rule.type)) throw badInput(`rule ${rule.id}: unknown type ${rule.type}`);
  }
  for (const rule of rules) {
    for (const dep of rule.dependsOn ?? []) {
      if (!ids.has(dep)) throw badInput(`rule ${rule.id}: unknown dependency ${dep}`);
    }
  }
  return rules;
}

// Kahn's algorithm with deterministic (id-sorted) tie-breaking.
// Throws RULE_CYCLE when the dependency graph has a cycle.
export function topoOrder(rules) {
  validateRules(rules);
  const indegree = new Map();
  const dependents = new Map();
  for (const rule of rules) {
    indegree.set(rule.id, (rule.dependsOn ?? []).length);
    dependents.set(rule.id, []);
  }
  for (const rule of rules) {
    for (const dep of rule.dependsOn ?? []) dependents.get(dep).push(rule.id);
  }
  const ready = rules.filter((r) => indegree.get(r.id) === 0).map((r) => r.id).sort();
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const next of dependents.get(id).sort()) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        const pos = ready.findIndex((x) => x > next);
        if (pos === -1) ready.push(next);
        else ready.splice(pos, 0, next);
      }
    }
  }
  if (order.length !== rules.length) {
    const stuck = rules.filter((r) => !order.includes(r.id)).map((r) => r.id);
    throw ruleCycle(findCycle(rules, stuck));
  }
  return order;
}

function findCycle(rules, candidates) {
  const deps = new Map(rules.map((r) => [r.id, r.dependsOn ?? []]));
  const inSet = new Set(candidates);
  const start = candidates[0];
  const path = [];
  const seen = new Map();
  let cur = start;
  while (!seen.has(cur)) {
    seen.set(cur, path.length);
    path.push(cur);
    const next = (deps.get(cur) ?? []).find((d) => inSet.has(d));
    if (next === undefined) return path;
    cur = next;
  }
  return [...path.slice(seen.get(cur)), cur];
}

export function evaluateRule(rule, data) {
  switch (rule.type) {
    case 'range': {
      const v = data[rule.var];
      if (typeof v !== 'number') return { rule: rule.id, reason: `${rule.var} is not numeric` };
      if (rule.min !== undefined && v < rule.min) return { rule: rule.id, reason: `${rule.var}=${v} < min ${rule.min}` };
      if (rule.max !== undefined && v > rule.max) return { rule: rule.id, reason: `${rule.var}=${v} > max ${rule.max}` };
      return null;
    }
    case 'eq': {
      const [a, b] = rule.vars;
      if (data[a] !== data[b]) return { rule: rule.id, reason: `${a}=${data[a]} != ${b}=${data[b]}` };
      return null;
    }
    case 'neq': {
      const [a, b] = rule.vars;
      if (data[a] === data[b]) return { rule: rule.id, reason: `${a} == ${b} (both ${data[a]})` };
      return null;
    }
    case 'sum_lte': {
      const sum = rule.vars.reduce((acc, v) => acc + (data[v] ?? 0), 0);
      if (sum > rule.limit) return { rule: rule.id, reason: `sum(${rule.vars.join(',')})=${sum} > ${rule.limit}` };
      return null;
    }
    case 'sum_gte': {
      const sum = rule.vars.reduce((acc, v) => acc + (data[v] ?? 0), 0);
      if (sum < rule.limit) return { rule: rule.id, reason: `sum(${rule.vars.join(',')})=${sum} < ${rule.limit}` };
      return null;
    }
    default:
      throw badInput(`unknown rule type: ${rule.type}`);
  }
}

// Evaluate rules in dependency (topological) order. Throws RULE_CYCLE on cycles.
export function checkData(data, rules) {
  const order = topoOrder(rules);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const violations = [];
  for (const id of order) {
    const violation = evaluateRule(byId.get(id), data);
    if (violation) violations.push(violation);
  }
  return { ok: violations.length === 0, order, violations };
}
