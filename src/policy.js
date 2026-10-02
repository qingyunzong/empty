export class PolicyError extends Error {
  constructor(message, exitCode, details = {}) {
    super(message);
    this.name = 'PolicyError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function parsePolicies(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(`policies: invalid JSON: ${err.message}`, 2);
  }
  return validatePolicies(data);
}

export function validatePolicies(policies) {
  if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) {
    throw new PolicyError('policies: top-level value must be an object', 2);
  }
  for (const key of ['roles', 'zones', 'subjects', 'devices']) {
    if (policies[key] === undefined) policies[key] = {};
    if (typeof policies[key] !== 'object' || policies[key] === null || Array.isArray(policies[key])) {
      throw new PolicyError(`policies.${key}: must be an object`, 2);
    }
  }
  if (policies.rules === undefined) policies.rules = [];
  if (!Array.isArray(policies.rules)) {
    throw new PolicyError('policies.rules: must be an array', 2);
  }

  validateInheritance('role', policies.roles);
  validateInheritance('zone', policies.zones);

  const roleCycle = findCycle(policies.roles);
  if (roleCycle) {
    throw new PolicyError(`role inheritance cycle: ${roleCycle.join(' -> ')}`, 4, { kind: 'role', cycle: roleCycle });
  }
  const zoneCycle = findCycle(policies.zones);
  if (zoneCycle) {
    throw new PolicyError(`zone inheritance cycle: ${zoneCycle.join(' -> ')}`, 4, { kind: 'zone', cycle: zoneCycle });
  }

  for (const [name, subject] of Object.entries(policies.subjects)) {
    for (const role of subject.roles ?? []) {
      if (!policies.roles[role]) {
        throw new PolicyError(`subject '${name}' references unknown role '${role}'`, 3);
      }
    }
  }
  for (const [name, device] of Object.entries(policies.devices)) {
    if (!device.zone) {
      throw new PolicyError(`device '${name}' is missing a zone`, 2);
    }
    if (!policies.zones[device.zone]) {
      throw new PolicyError(`device '${name}' references unknown zone '${device.zone}'`, 3);
    }
  }

  const seen = new Set();
  for (const rule of policies.rules) {
    if (!rule.id) throw new PolicyError('rule is missing an id', 2);
    if (seen.has(rule.id)) throw new PolicyError(`duplicate rule id '${rule.id}'`, 2);
    seen.add(rule.id);
    if (rule.effect !== 'allow' && rule.effect !== 'deny') {
      throw new PolicyError(`rule '${rule.id}': effect must be 'allow' or 'deny'`, 2);
    }
    if (!rule.action) throw new PolicyError(`rule '${rule.id}': missing action`, 2);
    if (rule.role !== undefined && !policies.roles[rule.role]) {
      throw new PolicyError(`rule '${rule.id}' references unknown role '${rule.role}'`, 3);
    }
    if (rule.zone !== undefined && !policies.zones[rule.zone]) {
      throw new PolicyError(`rule '${rule.id}' references unknown zone '${rule.zone}'`, 3);
    }
    if (rule.window) validateWindow(rule.id, rule.window);
    if (rule.revokeAt !== undefined && Number.isNaN(Date.parse(rule.revokeAt))) {
      throw new PolicyError(`rule '${rule.id}': revokeAt is not a valid timestamp`, 2);
    }
  }

  prepare(policies);
  return policies;
}

function validateInheritance(kind, graph) {
  for (const [name, node] of Object.entries(graph)) {
    const parents = node.inherits ?? [];
    if (!Array.isArray(parents)) {
      throw new PolicyError(`${kind} '${name}': inherits must be an array`, 2);
    }
    for (const parent of parents) {
      if (!graph[parent]) {
        throw new PolicyError(`${kind} '${name}' inherits from unknown ${kind} '${parent}'`, 3);
      }
    }
  }
}

function validateWindow(ruleId, window) {
  if (typeof window.start !== 'string' || typeof window.end !== 'string') {
    throw new PolicyError(`rule '${ruleId}': window needs start and end`, 2);
  }
  const daily = /^([01]\d|2[0-3]):[0-5]\d$/;
  const absolute = (v) => v.includes('T') && !Number.isNaN(Date.parse(v));
  const ok = (daily.test(window.start) && daily.test(window.end))
    || (absolute(window.start) && absolute(window.end));
  if (!ok) {
    throw new PolicyError(`rule '${ruleId}': window must be HH:MM/HH:MM or ISO/ISO`, 2);
  }
}

export function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const dfs = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const parent of graph[node].inherits ?? []) {
      if (state.get(parent) === 1) {
        return stack.slice(stack.indexOf(parent)).concat(parent);
      }
      if (!state.has(parent)) {
        const cycle = dfs(parent);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of Object.keys(graph)) {
    if (!state.has(node)) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function prepare(policies) {
  policies._roleAncestors = computeAncestors(policies.roles);
  policies._zoneAncestors = computeAncestors(policies.zones);
  return policies;
}

function computeAncestors(graph) {
  const result = new Map();
  for (const node of Object.keys(graph)) {
    const depths = new Map([[node, 0]]);
    const queue = [node];
    while (queue.length) {
      const current = queue.shift();
      const depth = depths.get(current);
      for (const parent of graph[current].inherits ?? []) {
        if (!depths.has(parent)) {
          depths.set(parent, depth + 1);
          queue.push(parent);
        }
      }
    }
    result.set(node, depths);
  }
  return result;
}
