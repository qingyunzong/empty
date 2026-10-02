'use strict';

const AMOUNT_DOMAIN = Object.freeze([0, 1, 50, 100, 101]);
const DEFAULT_ACTIONS = Object.freeze(['submit', 'approve']);
const MAX_SUBJECTS = 4;
const MAX_LENGTH = 6;

class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecError';
    this.code = 'E_PARSE';
  }
}

function fail(message) {
  throw new SpecError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(value, name, max) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} must be a non-empty array of strings`);
  }
  if (max !== undefined && value.length > max) {
    fail(`${name} allows at most ${max} entries, got ${value.length}`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) {
      fail(`${name} entries must be non-empty strings`);
    }
  }
  if (new Set(value).size !== value.length) {
    fail(`${name} must not contain duplicates`);
  }
  return [...value].sort();
}

function assertAcyclic(roles) {
  const state = new Map();
  const visit = (name) => {
    const mark = state.get(name) || 0;
    if (mark === 1) fail(`role inheritance cycle involving "${name}"`);
    if (mark === 2) return;
    state.set(name, 1);
    for (const parent of roles[name]) visit(parent);
    state.set(name, 2);
  };
  for (const name of Object.keys(roles)) visit(name);
}

function roleClosure(roles, assigned) {
  const out = new Set();
  const stack = [...assigned];
  while (stack.length > 0) {
    const role = stack.pop();
    if (out.has(role)) continue;
    out.add(role);
    for (const parent of roles[role] || []) stack.push(parent);
  }
  return out;
}

function parseSpec(raw) {
  if (!isPlainObject(raw)) fail('spec must be a JSON object');

  if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold)) {
    fail('threshold must be a finite number');
  }
  const threshold = raw.threshold;

  const rawAmounts = raw.amounts === undefined ? [...AMOUNT_DOMAIN] : raw.amounts;
  if (!Array.isArray(rawAmounts) || rawAmounts.length === 0) {
    fail('amounts must be a non-empty array');
  }
  for (const amount of rawAmounts) {
    if (!Number.isInteger(amount) || !AMOUNT_DOMAIN.includes(amount)) {
      fail(`amount ${JSON.stringify(amount)} is outside the domain [${AMOUNT_DOMAIN}]`);
    }
  }
  const amounts = [...new Set(rawAmounts)].sort((a, b) => a - b);

  const maxLength = raw.maxLength === undefined ? MAX_LENGTH : raw.maxLength;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > MAX_LENGTH) {
    fail(`maxLength must be an integer in 1..${MAX_LENGTH}`);
  }

  const subjects = parseStringArray(raw.subjects, 'subjects', MAX_SUBJECTS);

  const actions = raw.actions === undefined
    ? [...DEFAULT_ACTIONS].sort()
    : parseStringArray(raw.actions, 'actions');

  const rawRoles = raw.roles === undefined ? {} : raw.roles;
  if (!isPlainObject(rawRoles)) fail('roles must be an object mapping role -> parent roles');
  const roles = {};
  for (const [name, parents] of Object.entries(rawRoles)) {
    if (!Array.isArray(parents) || parents.some((p) => typeof p !== 'string' || p.length === 0)) {
      fail(`roles.${name} must be an array of parent role names`);
    }
    roles[name] = [...new Set(parents)].sort();
  }
  for (const [name, parents] of Object.entries(roles)) {
    for (const parent of parents) {
      if (!(parent in roles)) fail(`roles.${name} inherits unknown role "${parent}"`);
    }
  }
  assertAcyclic(roles);

  const rawAssignments = raw.assignments === undefined ? {} : raw.assignments;
  if (!isPlainObject(rawAssignments)) fail('assignments must be an object mapping subject -> roles');
  const assignments = {};
  for (const subject of subjects) assignments[subject] = [];
  for (const [subject, granted] of Object.entries(rawAssignments)) {
    if (!subjects.includes(subject)) fail(`assignments references unknown subject "${subject}"`);
    if (!Array.isArray(granted) || granted.some((g) => typeof g !== 'string' || !(g in roles))) {
      fail(`assignments.${subject} must be an array of defined role names`);
    }
    assignments[subject] = [...new Set(granted)].sort();
  }

  if (!Array.isArray(raw.rules)) fail('rules must be an array');
  const rules = raw.rules.map((rule, index) => {
    if (!isPlainObject(rule)) fail(`rules[${index}] must be an object`);
    const id = rule.id === undefined ? `r${index}` : rule.id;
    if (typeof id !== 'string' || id.length === 0) fail(`rules[${index}].id must be a non-empty string`);
    if (rule.effect !== 'allow' && rule.effect !== 'deny') {
      fail(`rules[${index}].effect must be "allow" or "deny"`);
    }
    if (typeof rule.role !== 'string' || !(rule.role in roles)) {
      fail(`rules[${index}].role must be a defined role`);
    }
    if (!actions.includes(rule.action)) {
      fail(`rules[${index}].action must be one of [${actions}]`);
    }
    const parsed = { id, effect: rule.effect, role: rule.role, action: rule.action };
    if (rule.self !== undefined) {
      if (typeof rule.self !== 'boolean') fail(`rules[${index}].self must be a boolean`);
      parsed.self = rule.self;
    }
    if (rule.amountGt !== undefined) {
      if (typeof rule.amountGt !== 'number' || !Number.isFinite(rule.amountGt)) {
        fail(`rules[${index}].amountGt must be a number`);
      }
      parsed.amountGt = rule.amountGt;
    }
    return parsed;
  });
  if (new Set(rules.map((r) => r.id)).size !== rules.length) {
    fail('rule ids must be unique');
  }

  const rawRevocations = raw.revocations === undefined ? [] : raw.revocations;
  if (!Array.isArray(rawRevocations)) fail('revocations must be an array');
  const ruleIds = new Set(rules.map((r) => r.id));
  const revocations = rawRevocations.map((rev, index) => {
    if (!isPlainObject(rev)) fail(`revocations[${index}] must be an object`);
    if (!ruleIds.has(rev.rule)) fail(`revocations[${index}].rule references unknown rule id`);
    if (!Number.isInteger(rev.at) || rev.at < 0) {
      fail(`revocations[${index}].at must be a non-negative integer position`);
    }
    return { rule: rev.rule, at: rev.at };
  });
  const revokedAt = new Map();
  for (const rev of revocations) {
    const prev = revokedAt.get(rev.rule);
    revokedAt.set(rev.rule, prev === undefined ? rev.at : Math.min(prev, rev.at));
  }

  const rawInvariant = raw.invariant === undefined ? {} : raw.invariant;
  if (!isPlainObject(rawInvariant)) fail('invariant must be an object');
  const invariant = {
    role: rawInvariant.role === undefined ? 'clerk' : rawInvariant.role,
    first: rawInvariant.first === undefined ? 'submit' : rawInvariant.first,
    second: rawInvariant.second === undefined ? 'approve' : rawInvariant.second,
  };
  if (!(invariant.role in roles)) fail(`invariant.role "${invariant.role}" is not a defined role`);
  if (!actions.includes(invariant.first) || !actions.includes(invariant.second)) {
    fail('invariant.first / invariant.second must be declared actions');
  }
  if (invariant.first === invariant.second) {
    fail('invariant.first and invariant.second must differ');
  }

  const subjectRoles = {};
  for (const subject of subjects) {
    subjectRoles[subject] = roleClosure(roles, assignments[subject]);
  }

  return {
    threshold,
    amounts,
    maxLength,
    subjects,
    actions,
    roles,
    assignments,
    rules,
    revocations,
    revokedAt,
    invariant,
    subjectRoles,
    canonical: {
      threshold,
      amounts,
      maxLength,
      subjects,
      actions,
      roles,
      assignments,
      rules,
      revocations,
      invariant,
    },
  };
}

module.exports = { AMOUNT_DOMAIN, SpecError, parseSpec };
