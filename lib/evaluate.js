'use strict';

const { LineError, parseJsonl } = require('./jsonl');
const { computeAncestors, isRevokedAt } = require('./policy');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Events (events.jsonl):
//   {"type":"authorize","id":"e1","role":"ops","resource":"merchant:42","at":"2026-01-01T00:00:00Z"}
function parseEvents(text) {
  const records = parseJsonl(text);
  return records.map(({ value: rec, line }) => {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || rec.type !== 'authorize') {
      throw new LineError('E_SCHEMA', line, 'event must be an object with type "authorize"');
    }
    for (const key of ['id', 'role', 'resource']) {
      if (!isNonEmptyString(rec[key])) throw new LineError('E_SCHEMA', line, `event.${key} must be a non-empty string`);
    }
    if (typeof rec.at !== 'string' || Number.isNaN(Date.parse(rec.at))) {
      throw new LineError('E_SCHEMA', line, 'event.at must be a valid timestamp');
    }
    return { id: rec.id, role: rec.role, resource: rec.resource, at: rec.at, line };
  });
}

// Resource patterns: exact match, or trailing-"*" prefix wildcard ("merchant:*"),
// or "*" matching everything.
function resourceMatches(pattern, resource) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return resource.startsWith(pattern.slice(0, -1));
  return pattern === resource;
}

// Decide a single authorize event against the policy at the event's time.
// Precedence among matching rules: explicit deny > allow, then nearer ancestor
// (fewer hops) > farther, then rule id lexicographic. Default is deny.
// Revocation of a role at time T disables that role (and rules inherited
// through it) only for events at or after T; earlier history is untouched.
function decide(policy, event) {
  const time = Date.parse(event.at);
  const base = { id: event.id, role: event.role, resource: event.resource, at: event.at };

  if (!policy.roles.has(event.role)) {
    return { ...base, decision: 'deny', rule: null, path: [], reason: 'unknown_role' };
  }
  if (isRevokedAt(policy, event.role, time)) {
    return { ...base, decision: 'deny', rule: null, path: [], reason: 'role_revoked' };
  }

  const ancestors = computeAncestors(policy, event.role);
  const candidates = [];
  for (const [name, info] of ancestors) {
    if (name !== event.role && isRevokedAt(policy, name, time)) continue; // revoked ancestor contributes nothing
    for (const rule of policy.rulesByRole.get(name) ?? []) {
      if (resourceMatches(rule.resource, event.resource)) {
        candidates.push({ rule, dist: info.dist, path: info.path });
      }
    }
  }

  if (candidates.length === 0) {
    return { ...base, decision: 'deny', rule: null, path: [], reason: 'no_matching_rule' };
  }

  candidates.sort((a, b) =>
    (a.rule.effect === 'deny' ? 0 : 1) - (b.rule.effect === 'deny' ? 0 : 1)
    || a.dist - b.dist
    || (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0),
  );
  const winner = candidates[0];
  const conflicts = candidates.filter((c) => c.rule.id !== winner.rule.id).map((c) => c.rule.id);

  let reason;
  if (winner.rule.effect === 'deny') {
    reason = conflicts.some((id) => candidates.find((c) => c.rule.id === id).rule.effect === 'allow')
      ? `deny rule ${winner.rule.id} overrides allow (explicit deny wins)`
      : `denied by rule ${winner.rule.id}`;
  } else {
    reason = `allowed by rule ${winner.rule.id}`;
  }

  return {
    ...base,
    decision: winner.rule.effect,
    rule: winner.rule.id,
    path: winner.path,
    reason,
    ...(conflicts.length ? { conflicts } : {}),
  };
}

module.exports = { parseEvents, decide, resourceMatches };
