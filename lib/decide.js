'use strict';

const { ancestorsWithDistance } = require('./graph');

// Compares two timestamps. Numbers compare numerically; anything else
// compares lexicographically on its string form (ISO-8601 safe).
function compareTs(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Conflict ordering, highest priority first:
//   1. explicit deny beats allow
//   2. nearer ancestor (shorter inheritance distance) beats farther
//   3. lexicographically smaller rule id wins the tie
function compareCandidates(x, y) {
  if (x.rule.effect !== y.rule.effect) return x.rule.effect === 'deny' ? -1 : 1;
  if (x.distance !== y.distance) return x.distance - y.distance;
  if (x.rule.id !== y.rule.id) return x.rule.id < y.rule.id ? -1 : 1;
  return 0;
}

// Decides a single authorize event against a loaded policy.
// A revocation of role R at time T removes R's own rules for events with
// ts >= T; inheritance edges and other roles are unaffected, and events
// before T keep the historical outcome.
function decide(policy, event) {
  const revoked = new Set();
  for (const rv of policy.revocations) {
    if (compareTs(event.ts, rv.at) >= 0) revoked.add(rv.role);
  }

  const ancestors = ancestorsWithDistance(policy.adj, event.role);
  const candidates = [];
  for (const rule of policy.rules) {
    if (rule.resource !== event.resource) continue;
    if (revoked.has(rule.role)) continue;
    const via = ancestors.get(rule.role);
    if (!via) continue;
    candidates.push({ rule, distance: via.distance, path: via.path });
  }

  if (candidates.length === 0) {
    return {
      id: event.id,
      decision: 'deny',
      rule: null,
      path: [],
      reason: 'DEFAULT_DENY',
      candidates: 0,
    };
  }

  candidates.sort(compareCandidates);
  const winner = candidates[0];
  const hasAllow = candidates.some((c) => c.rule.effect === 'allow');

  let reason;
  if (winner.rule.effect === 'deny') {
    reason = hasAllow ? 'DENY_OVERRIDES_ALLOW' : 'EXPLICIT_DENY';
  } else {
    reason = 'EXPLICIT_ALLOW';
  }

  return {
    id: event.id,
    decision: winner.rule.effect,
    rule: winner.rule.id,
    path: winner.path,
    reason,
    candidates: candidates.length,
  };
}

module.exports = { decide, compareTs, compareCandidates };
