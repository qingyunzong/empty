'use strict';

class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
    this.code = 'E_PARSE';
  }
}

function fail(message) {
  throw new ParseError(message);
}

const ALLOWED_AMOUNTS = [0, 1, 50, 100, 101];
const RULE_ACTIONS = new Set(['submit', 'approve']);
const INVARIANT_TYPES = new Set(['no_self_approval_over_threshold']);
const MAX_SUBJECTS = 4;
const MAX_BOUND = 6;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function parseSubjects(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('subjects must be a non-empty array');
  }
  if (raw.length > MAX_SUBJECTS) {
    fail(`subjects must contain at most ${MAX_SUBJECTS} entries`);
  }
  for (const subject of raw) {
    if (!isNonEmptyString(subject)) fail('each subject must be a non-empty string');
  }
  if (new Set(raw).size !== raw.length) fail('subjects must be unique');
  return raw.slice();
}

function parseAmounts(raw) {
  const amounts = raw === undefined ? ALLOWED_AMOUNTS.slice() : raw;
  if (!Array.isArray(amounts) || amounts.length === 0) {
    fail('amounts must be a non-empty array');
  }
  for (const amount of amounts) {
    if (!Number.isInteger(amount) || !ALLOWED_AMOUNTS.includes(amount)) {
      fail('amounts must be drawn from {0,1,50,100,101}');
    }
  }
  return [...new Set(amounts)].sort((a, b) => a - b);
}

function parseBound(raw) {
  const bound = raw === undefined ? MAX_BOUND : raw;
  if (!Number.isInteger(bound) || bound < 1 || bound > MAX_BOUND) {
    fail(`bound must be an integer in [1,${MAX_BOUND}]`);
  }
  return bound;
}

function parseRoles(raw) {
  const roles = raw === undefined ? {} : raw;
  if (!isPlainObject(roles)) fail('policy.roles must be an object');
  const out = {};
  for (const [name, def] of Object.entries(roles)) {
    if (!isNonEmptyString(name)) fail('role names must be non-empty strings');
    if (!isPlainObject(def)) fail(`role "${name}" must be an object`);
    const inherits = def.inherits === undefined ? [] : def.inherits;
    if (!Array.isArray(inherits) || inherits.some((r) => !isNonEmptyString(r))) {
      fail(`role "${name}".inherits must be an array of role names`);
    }
    out[name] = { inherits: inherits.slice() };
  }
  for (const [name, def] of Object.entries(out)) {
    for (const parent of def.inherits) {
      if (!(parent in out)) fail(`role "${name}" inherits unknown role "${parent}"`);
    }
  }
  const mark = {};
  const visit = (name) => {
    const state = mark[name] || 0;
    if (state === 1) fail(`role inheritance cycle involving "${name}"`);
    if (state === 2) return;
    mark[name] = 1;
    for (const parent of out[name].inherits) visit(parent);
    mark[name] = 2;
  };
  for (const name of Object.keys(out)) visit(name);
  return out;
}

function parseSubjectRoles(raw, subjects, roles) {
  const subjectRoles = raw === undefined ? {} : raw;
  if (!isPlainObject(subjectRoles)) fail('policy.subjectRoles must be an object');
  const out = {};
  for (const [subject, assigned] of Object.entries(subjectRoles)) {
    if (!subjects.includes(subject)) {
      fail(`policy.subjectRoles references unknown subject "${subject}"`);
    }
    if (!Array.isArray(assigned) || assigned.some((r) => !isNonEmptyString(r))) {
      fail(`policy.subjectRoles["${subject}"] must be an array of role names`);
    }
    for (const role of assigned) {
      if (!(role in roles)) fail(`subject "${subject}" assigned unknown role "${role}"`);
    }
    out[subject] = [...new Set(assigned)];
  }
  return out;
}

function parseRules(raw, roles) {
  if (!Array.isArray(raw)) fail('policy.rules must be an array');
  const seen = new Set();
  return raw.map((rule, index) => {
    if (!isPlainObject(rule)) fail(`policy.rules[${index}] must be an object`);
    const { id, effect, role, action } = rule;
    if (!isNonEmptyString(id)) fail(`policy.rules[${index}].id must be a non-empty string`);
    if (seen.has(id)) fail(`duplicate rule id "${id}"`);
    seen.add(id);
    if (effect !== 'allow' && effect !== 'deny') {
      fail(`rule "${id}".effect must be "allow" or "deny"`);
    }
    if (!isNonEmptyString(role) || !(role in roles)) {
      fail(`rule "${id}" references unknown role "${role}"`);
    }
    if (!RULE_ACTIONS.has(action)) {
      fail(`rule "${id}".action must be one of "submit", "approve"`);
    }
    const minAmount = rule.minAmount === undefined ? null : rule.minAmount;
    const maxAmount = rule.maxAmount === undefined ? null : rule.maxAmount;
    for (const [key, value] of [['minAmount', minAmount], ['maxAmount', maxAmount]]) {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        fail(`rule "${id}".${key} must be a finite number`);
      }
    }
    if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
      fail(`rule "${id}" has minAmount > maxAmount`);
    }
    const revocable = rule.revocable === undefined ? false : rule.revocable;
    if (typeof revocable !== 'boolean') fail(`rule "${id}".revocable must be a boolean`);
    return { id, effect, role, action, minAmount, maxAmount, revocable };
  });
}

function parseInvariant(raw) {
  if (!isPlainObject(raw)) fail('invariant must be an object');
  if (!INVARIANT_TYPES.has(raw.type)) {
    fail(`invariant.type must be one of ${[...INVARIANT_TYPES].join(', ')}`);
  }
  if (typeof raw.threshold !== 'number' || !Number.isFinite(raw.threshold)) {
    fail('invariant.threshold must be a finite number');
  }
  return { type: raw.type, threshold: raw.threshold };
}

function computeRoleClosure(roles, subjectRoles, subjects) {
  const closure = {};
  for (const subject of subjects) {
    const seen = new Set();
    const stack = [...(subjectRoles[subject] || [])];
    while (stack.length > 0) {
      const role = stack.pop();
      if (seen.has(role)) continue;
      seen.add(role);
      for (const parent of roles[role].inherits) stack.push(parent);
    }
    closure[subject] = [...seen].sort();
  }
  return closure;
}

function parseSpec(raw) {
  if (!isPlainObject(raw)) fail('spec must be a JSON object');
  const subjects = parseSubjects(raw.subjects);
  const amounts = parseAmounts(raw.amounts);
  const bound = parseBound(raw.bound);
  if (!isPlainObject(raw.policy)) fail('policy must be an object');
  const roles = parseRoles(raw.policy.roles);
  const subjectRoles = parseSubjectRoles(raw.policy.subjectRoles, subjects, roles);
  const rules = parseRules(raw.policy.rules, roles);
  const invariant = parseInvariant(raw.invariant);
  const roleClosure = computeRoleClosure(roles, subjectRoles, subjects);
  const rulesById = {};
  for (const rule of rules) rulesById[rule.id] = rule;
  return { subjects, amounts, bound, roles, subjectRoles, rules, rulesById, invariant, roleClosure };
}

module.exports = { ParseError, parseSpec, ALLOWED_AMOUNTS, MAX_SUBJECTS, MAX_BOUND };
