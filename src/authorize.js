'use strict';

const {
  GateError,
  classificationLevel,
  effectiveClassificationLevel,
  isRegulatory,
} = require('./policy');

// Permission inheritance chain: organization -> role -> individual.
function resolveChain(policy, principal) {
  const orgs = policy.orgs || {};
  const roles = policy.roles || {};
  const individuals = policy.individuals || {};
  if (individuals[principal]) {
    const ind = individuals[principal];
    const role = roles[ind.role];
    const org = role && orgs[role.org];
    return [
      { kind: 'org', name: role.org, def: org },
      { kind: 'role', name: ind.role, def: role },
      { kind: 'individual', name: principal, def: ind },
    ];
  }
  if (roles[principal]) {
    const role = roles[principal];
    return [
      { kind: 'org', name: role.org, def: orgs[role.org] },
      { kind: 'role', name: principal, def: role },
    ];
  }
  throw new GateError(`unknown principal "${principal}"`, 2);
}

function clearanceFromChain(policy, chain) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i].def && chain[i].def.clearance;
    if (c !== undefined) return classificationLevel(policy, c);
  }
  return 0;
}

// Full authorization decision for one (principal, field) pair.
// Grants accumulate down the chain; a deny at any level wins.
function authorizeField(policy, principal, field) {
  const chain = resolveChain(policy, principal);
  const grants = [];
  const denials = [];
  for (const level of chain) {
    if ((level.def.allow || []).includes(field)) grants.push(`${level.kind}:${level.name}`);
    if ((level.def.deny || []).includes(field)) denials.push(`${level.kind}:${level.name}`);
  }
  const allowed = grants.length > 0 && denials.length === 0;
  const clearance = clearanceFromChain(policy, chain);
  const classification = effectiveClassificationLevel(policy, field);
  const regulatory = isRegulatory(policy, field);
  let visible;
  if (classification === null) {
    visible = false; // field unknown to the policy is never published
  } else {
    visible = allowed && clearance >= classification;
  }
  return {
    field,
    visible,
    allowed,
    grants,
    denials,
    clearance,
    classification,
    regulatory,
    path: grants,
  };
}

module.exports = { resolveChain, clearanceFromChain, authorizeField };
