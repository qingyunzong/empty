'use strict';

const { subjectClosure, parentMap } = require('./policy');
const { CodedError } = require('./errors');

const ACTIONS = ['read', 'modify', 'mark_false_positive'];
const SAFETY_TAG = 'safety-public';
const DOWNTIME_TYPE = 'downtime';

function ruleApplies(rule, closureSet, event, device, action, atMs) {
  if (!rule.actions.includes(action)) return false;
  if (!closureSet.has(rule.subject)) return false;
  if (rule.revokedAt && Date.parse(rule.revokedAt) <= atMs) return false;
  if (rule.event) return rule.event === event.eventId; // event-level exception
  return device.tags.includes(rule.tag); // tag-level grant
}

function safetyBreakApplies(event, device, action) {
  return event.type === DOWNTIME_TYPE && device.tags.includes(SAFETY_TAG) && action === 'read';
}

// Main evaluator. Returns { allow, matchedRules, brokenDeny?, counterexample? }.
function evaluate(policy, subjectId, event, device, action, at) {
  const atMs = Date.parse(at);
  const closureSet = new Set(subjectClosure(policy, subjectId));
  const matched = policy.rules.filter((r) => ruleApplies(r, closureSet, event, device, action, atMs));
  const denies = matched.filter((r) => r.effect === 'deny');
  const allows = matched.filter((r) => r.effect === 'allow');
  const base = { subject: subjectId, event: event.eventId, action, matchedRules: matched.map((r) => r.id) };

  if (denies.length > 0) {
    if (allows.length > 0 && safetyBreakApplies(event, device, action)) {
      return {
        ...base,
        allow: true,
        brokenDeny: {
          denyRule: denies[0].id,
          allowRule: allows[0].id,
          reason: `event is '${DOWNTIME_TYPE}' on a '${SAFETY_TAG}' device; allow rule '${allows[0].id}' breaks deny rule '${denies[0].id}' for action 'read'`,
        },
      };
    }
    return {
      ...base,
      allow: false,
      counterexample: {
        kind: 'extra_revocation',
        ruleId: denies[0].id,
        message: `deny rule '${denies[0].id}' applies; removing/revoking exactly this rule would allow the request`,
      },
    };
  }
  if (allows.length > 0) return { ...base, allow: true };
  return {
    ...base,
    allow: false,
    counterexample: {
      kind: 'missing_grant',
      grant: { effect: 'allow', subject: subjectId, tag: device.tags[0] ?? null, actions: [action] },
      message: `no allow rule grants '${action}' to '${subjectId}' on device tags [${device.tags.join(', ')}]`,
    },
  };
}

// Reference evaluator: independent, set-fixpoint based. Used to cross-check `evaluate`.
function referenceEvaluate(policy, subjectId, event, device, action, at) {
  const atMs = Date.parse(at);
  const parents = parentMap(policy);
  // members[id] = set of subjects whose ancestor closure contains id (including id itself).
  const members = new Map();
  for (const id of parents.keys()) members.set(id, new Set([id]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, ps] of parents) {
      for (const p of ps) {
        if (!members.has(p)) members.set(p, new Set());
        for (const m of members.get(id)) {
          if (!members.get(p).has(m)) {
            members.get(p).add(m);
            changed = true;
          }
        }
      }
    }
  }
  // Cycle check: a parent that is also a descendant of its child means a cycle.
  for (const [id, ps] of parents) {
    for (const p of ps) {
      if (members.get(id).has(p)) throw new CodedError(4, `tenant/group inheritance cycle detected at '${id}'`);
    }
  }
  const matched = [];
  for (const rule of policy.rules) {
    if (!rule.actions.includes(action)) continue;
    if (!(members.get(rule.subject) || new Set()).has(subjectId)) continue;
    if (rule.revokedAt && Date.parse(rule.revokedAt) <= atMs) continue;
    if (rule.event ? rule.event !== event.eventId : !device.tags.includes(rule.tag)) continue;
    matched.push(rule);
  }
  const denies = matched.filter((r) => r.effect === 'deny');
  const allows = matched.filter((r) => r.effect === 'allow');
  if (denies.length > 0) {
    if (allows.length > 0 && safetyBreakApplies(event, device, action)) return { allow: true, brokeDeny: true };
    return { allow: false };
  }
  return { allow: allows.length > 0 };
}

module.exports = { evaluate, referenceEvaluate, ACTIONS, SAFETY_TAG, DOWNTIME_TYPE };
