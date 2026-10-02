'use strict';

const { LineError, parseJsonl } = require('./jsonl');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isValidTime(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

// A policy is built from policy.jsonl records:
//   {"type":"role","role":"ops","inherits":["base"]}
//   {"type":"rule","id":"r1","role":"ops","resource":"merchant:*","effect":"allow"|"deny"}
//   {"type":"revoke","role":"ops","at":"2026-01-02T00:00:00Z"}
function buildPolicy(records) {
  const roles = new Map(); // name -> { inherits: [name], line }
  const rules = []; // { id, role, resource, effect, line }
  const rulesByRole = new Map(); // role -> rules[]
  const revocations = new Map(); // role -> [epochMs]

  const addEdgeAndCheckCycle = (role, parents, line) => {
    // Adding edges role -> parent for each parent. A cycle forms iff some
    // parent can already reach `role` in the current graph (or parent === role).
    for (const parent of parents) {
      if (parent === role) {
        throw new LineError('E_CYCLE', line, `role "${role}" inherits itself`);
      }
      if (reachable(roles, parent, role)) {
        throw new LineError('E_CYCLE', line, `inheritance cycle via "${role}" -> "${parent}"`);
      }
    }
    roles.get(role).inherits.push(...parents);
  };

  for (const { value: rec, line } of records) {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || !isNonEmptyString(rec.type)) {
      throw new LineError('E_SCHEMA', line, 'record must be an object with a "type" string');
    }
    switch (rec.type) {
      case 'role': {
        if (!isNonEmptyString(rec.role)) throw new LineError('E_SCHEMA', line, 'role.role must be a non-empty string');
        if (rec.inherits !== undefined && !(Array.isArray(rec.inherits) && rec.inherits.every(isNonEmptyString))) {
          throw new LineError('E_SCHEMA', line, 'role.inherits must be an array of role names');
        }
        if (roles.has(rec.role)) throw new LineError('E_DUP_ROLE', line, `duplicate role "${rec.role}"`);
        roles.set(rec.role, { inherits: [], line });
        addEdgeAndCheckCycle(rec.role, rec.inherits ?? [], line);
        break;
      }
      case 'rule': {
        if (!isNonEmptyString(rec.id)) throw new LineError('E_SCHEMA', line, 'rule.id must be a non-empty string');
        if (!isNonEmptyString(rec.role)) throw new LineError('E_SCHEMA', line, 'rule.role must be a non-empty string');
        if (!isNonEmptyString(rec.resource)) throw new LineError('E_SCHEMA', line, 'rule.resource must be a non-empty string');
        if (rec.effect !== 'allow' && rec.effect !== 'deny') {
          throw new LineError('E_SCHEMA', line, 'rule.effect must be "allow" or "deny"');
        }
        const rule = { id: rec.id, role: rec.role, resource: rec.resource, effect: rec.effect, line };
        rules.push(rule);
        if (!rulesByRole.has(rule.role)) rulesByRole.set(rule.role, []);
        rulesByRole.get(rule.role).push(rule);
        break;
      }
      case 'revoke': {
        if (!isNonEmptyString(rec.role)) throw new LineError('E_SCHEMA', line, 'revoke.role must be a non-empty string');
        if (!isValidTime(rec.at)) throw new LineError('E_SCHEMA', line, 'revoke.at must be a valid timestamp');
        if (!revocations.has(rec.role)) revocations.set(rec.role, []);
        revocations.get(rec.role).push(Date.parse(rec.at));
        break;
      }
      default:
        throw new LineError('E_SCHEMA', line, `unknown record type "${rec.type}"`);
    }
  }

  // Cross-reference validation now that all roles are known.
  for (const [name, role] of roles) {
    for (const parent of role.inherits) {
      if (!roles.has(parent)) {
        throw new LineError('E_UNKNOWN_ROLE', role.line, `role "${name}" inherits unknown role "${parent}"`);
      }
    }
  }
  for (const rule of rules) {
    if (!roles.has(rule.role)) {
      throw new LineError('E_UNKNOWN_ROLE', rule.line, `rule "${rule.id}" references unknown role "${rule.role}"`);
    }
  }
  for (const [name] of revocations) {
    if (!roles.has(name)) {
      const line = records.find((r) => r.value.type === 'revoke' && r.value.role === name).line;
      throw new LineError('E_UNKNOWN_ROLE', line, `revoke references unknown role "${name}"`);
    }
  }

  return { roles, rules, rulesByRole, revocations };
}

// Can `from` reach `target` following inherits edges? (cycle-safe: visited set)
function reachable(roles, from, target) {
  const start = roles.get(from);
  if (!start) return false;
  const stack = [...start.inherits];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === target) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = roles.get(cur);
    if (node) stack.push(...node.inherits);
  }
  return false;
}

// BFS from `role` over inherits edges. Returns Map name -> { dist, path }
// where dist is the shortest hop count (0 for `role` itself) and path is a
// shortest inheritance path starting at `role`.
function computeAncestors(policy, role) {
  const result = new Map([[role, { dist: 0, path: [role] }]]);
  const queue = [role];
  while (queue.length) {
    const cur = queue.shift();
    const info = result.get(cur);
    const node = policy.roles.get(cur);
    if (!node) continue;
    for (const parent of node.inherits) {
      if (!result.has(parent)) {
        result.set(parent, { dist: info.dist + 1, path: [...info.path, parent] });
        queue.push(parent);
      }
    }
  }
  return result;
}

function isRevokedAt(policy, role, epochMs) {
  const times = policy.revocations.get(role);
  if (!times) return false;
  return times.some((t) => epochMs >= t);
}

function loadPolicy(text) {
  return buildPolicy(parseJsonl(text));
}

module.exports = { buildPolicy, loadPolicy, computeAncestors, isRevokedAt, reachable };
