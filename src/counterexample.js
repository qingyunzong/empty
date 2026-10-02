'use strict';

const { loadPolicies } = require('./model');
const { evaluateInternal } = require('./evaluate');

function applyMutation(rawPolicies, request, mutation) {
  const raw = structuredClone(rawPolicies);
  const req = structuredClone(request);
  switch (mutation.type) {
    case 'revoke_rule':
    case 'revoke_rules': {
      const ids = mutation.type === 'revoke_rule' ? [mutation.ruleId] : mutation.ruleIds;
      for (const r of raw.rules) {
        if (ids.includes(r.id)) {
          r.revokeAt = mutation.at;
          r.retroactive = false;
        }
      }
      break;
    }
    case 'unrevoke_rule': {
      for (const r of raw.rules) {
        if (r.id === mutation.ruleId) {
          r.revokeAt = null;
          r.retroactive = false;
        }
      }
      break;
    }
    case 'set_rule_effect': {
      for (const r of raw.rules) {
        if (r.id === mutation.ruleId) r.effect = mutation.effect;
      }
      break;
    }
    case 'set_time':
      req.time = mutation.time;
      break;
    case 'set_subject_roles':
      raw.subjects[req.subject].roles = mutation.roles.slice();
      break;
    case 'set_device_zone':
      raw.devices[req.device].zone = mutation.zone;
      break;
    case 'add_rule':
      raw.rules.push(structuredClone(mutation.rule));
      break;
    default:
      throw new Error(`unknown mutation type '${mutation.type}'`);
  }
  return { rawPolicies: raw, request: req };
}

function evaluateMutation(policies, request, mutation) {
  const { rawPolicies, request: req } = applyMutation(policies.raw, request, mutation);
  let loaded;
  try {
    loaded = loadPolicies(rawPolicies);
  } catch {
    return null;
  }
  const { record } = evaluateInternal(loaded, req);
  return record.decision;
}

function mirrorRule(decisiveRule, request, effect) {
  const rule = { id: `__cx_${effect}__`, action: request.action, effect };
  if (decisiveRule.role !== null) rule.role = decisiveRule.role;
  if (decisiveRule.zone !== null) rule.zone = decisiveRule.zone;
  return rule;
}

// Candidates that revive an inapplicable allow rule with one change.
function reviveAllowCandidates(inapplicable, subject) {
  const candidates = [];
  for (const item of inapplicable) {
    if (item.rule.effect !== 'allow') continue;
    if (item.why === 'revoked' || item.why === 'retroactive_revocation') {
      candidates.push({ type: 'unrevoke_rule', ruleId: item.rule.id });
    } else if (item.why === 'outside_window') {
      candidates.push({ type: 'set_time', time: item.rule.window.start });
    } else if (item.why === 'role_mismatch') {
      candidates.push({ type: 'set_subject_roles', roles: [...subject.roles, item.rule.role] });
    } else if (item.why === 'zone_mismatch') {
      candidates.push({ type: 'set_device_zone', zone: item.rule.zone });
    }
  }
  return candidates;
}

function buildCandidates(policies, request, record, context) {
  const candidates = [];
  const { decisive, inapplicable, subject, device } = context;

  if (record.decision === 'allow') {
    for (const item of inapplicable) {
      if (item.why === 'retroactive_revocation' && item.rule.effect === 'deny') {
        candidates.push({ type: 'unrevoke_rule', ruleId: item.rule.id });
      }
    }
    if (decisive.length === 1) {
      candidates.push({ type: 'revoke_rule', ruleId: decisive[0].rule.id, at: request.time });
    }
    if (decisive.length > 0) {
      candidates.push({ type: 'add_rule', rule: mirrorRule(decisive[0].rule, request, 'deny') });
    }
    const windowed = decisive.find((d) => d.rule.window !== null);
    if (windowed) {
      candidates.push({
        type: 'set_time',
        time: new Date(Date.parse(windowed.rule.window.end) + 1000).toISOString(),
      });
    }
    candidates.push({ type: 'set_subject_roles', roles: [] });
    if (decisive.length > 1) {
      candidates.push({
        type: 'revoke_rules',
        ruleIds: decisive.map((d) => d.rule.id),
        at: request.time,
      });
    }
  } else {
    candidates.push(...reviveAllowCandidates(inapplicable, subject));
    const denies = decisive.filter((d) => d.rule.effect === 'deny');
    if (denies.length === 1) {
      candidates.push({ type: 'revoke_rule', ruleId: denies[0].rule.id, at: request.time });
      candidates.push({ type: 'set_rule_effect', ruleId: denies[0].rule.id, effect: 'allow' });
    }
    const windowed = denies.find((d) => d.rule.window !== null);
    if (windowed) {
      candidates.push({
        type: 'set_time',
        time: new Date(Date.parse(windowed.rule.window.end) + 1000).toISOString(),
      });
    }
    if (record.reason === 'no_matching_rule') {
      const rule = { id: '__cx_allow__', action: request.action, effect: 'allow' };
      if (subject.roles.length > 0) rule.role = subject.roles[0];
      rule.zone = device.zone;
      candidates.push({ type: 'add_rule', rule });
    }
    candidates.push({ type: 'set_subject_roles', roles: [] });
    if (denies.length > 1) {
      candidates.push({
        type: 'revoke_rules',
        ruleIds: denies.map((d) => d.rule.id),
        at: request.time,
      });
    }
  }
  return candidates;
}

function findCounterexample(policies, request, record, context) {
  const candidates = buildCandidates(policies, request, record, context);
  for (const mutation of candidates) {
    const flipped = evaluateMutation(policies, request, mutation);
    if (flipped !== null && flipped !== record.decision) {
      return {
        flips: true,
        changes: mutation.type === 'revoke_rules' ? mutation.ruleIds.length : 1,
        mutation,
        resultingDecision: flipped,
        verified: true,
      };
    }
  }
  return { flips: false, note: 'no single-step mutation flips this decision' };
}

function verifyCounterexample(policies, request, counterexample) {
  if (!counterexample || !counterexample.flips) {
    return { valid: false, reason: 'no counterexample to verify' };
  }
  const actual = evaluateMutation(policies, request, counterexample.mutation);
  return {
    valid: actual === counterexample.resultingDecision,
    actual,
    expected: counterexample.resultingDecision,
  };
}

function verifyDecision(policies, request, claimedDecision) {
  const { record } = evaluateInternal(policies, request);
  return { match: record.decision === claimedDecision, actual: record.decision };
}

module.exports = {
  applyMutation,
  evaluateMutation,
  findCounterexample,
  verifyCounterexample,
  verifyDecision,
};
