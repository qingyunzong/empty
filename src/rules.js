import { DqError, RULE_CYCLE, BAD_INPUT } from './errors.js';

// Supported rule types:
//   { id, type: 'range',  var, min, max }        min <= data[var] <= max
//   { id, type: 'leq',    a, b }                 data[a] <= data[b]
//   { id, type: 'eq',     a, b }                 data[a] === data[b]
//   { id, type: 'sumLeq', vars: [...], bound }   sum(data[vars]) <= bound
//   { id, type: 'sumEq',  vars: [...], bound }   sum(data[vars]) === bound
// Optional field on every rule: dependsOn: [ruleId, ...]

export function ruleVars(rule) {
  switch (rule.type) {
    case 'range': return [rule.var];
    case 'leq':
    case 'eq': return [rule.a, rule.b];
    case 'sumLeq':
    case 'sumEq': return [...rule.vars];
    default: throw new DqError(BAD_INPUT, `unknown rule type: ${rule.type}`);
  }
}

// get: (varName) => number. All referenced variables must be available.
export function evalRule(rule, get) {
  switch (rule.type) {
    case 'range': {
      const v = get(rule.var);
      return v >= rule.min && v <= rule.max;
    }
    case 'leq': return get(rule.a) <= get(rule.b);
    case 'eq': return get(rule.a) === get(rule.b);
    case 'sumLeq': {
      let s = 0;
      for (const x of rule.vars) s += get(x);
      return s <= rule.bound;
    }
    case 'sumEq': {
      let s = 0;
      for (const x of rule.vars) s += get(x);
      return s === rule.bound;
    }
    default: throw new DqError(BAD_INPUT, `unknown rule type: ${rule.type}`);
  }
}

// Depth-first topological sort over the rule dependency graph.
// Throws RULE_CYCLE (with the cycle path) when a cycle exists.
export function topoSort(rules) {
  const byId = new Map();
  for (const r of rules) {
    if (!r.id) throw new DqError(BAD_INPUT, 'rule missing id');
    if (byId.has(r.id)) throw new DqError(BAD_INPUT, `duplicate rule id: ${r.id}`);
    byId.set(r.id, r);
  }
  const state = new Map(); // 1 = on stack, 2 = done
  const stack = [];
  const order = [];
  const visit = (id) => {
    const st = state.get(id) || 0;
    if (st === 2) return;
    if (st === 1) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      throw new DqError(RULE_CYCLE, `rule dependency cycle: ${cycle.join(' -> ')}`, { cycle });
    }
    const rule = byId.get(id);
    if (!rule) throw new DqError(BAD_INPUT, `unknown rule dependency: ${id}`);
    state.set(id, 1);
    stack.push(id);
    for (const dep of rule.dependsOn || []) visit(dep);
    stack.pop();
    state.set(id, 2);
    order.push(id);
  };
  for (const r of rules) visit(r.id);
  return order;
}

// Evaluate all rules (in dependency order) against a data record.
export function checkData(rules, data) {
  const order = topoSort(rules);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const violations = [];
  for (const id of order) {
    const rule = byId.get(id);
    if (!evalRule(rule, (x) => data[x])) {
      violations.push({ rule: id, type: rule.type });
    }
  }
  return { order, violations };
}
