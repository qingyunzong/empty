'use strict';

const RULE_FIELDS = ['id', 'material', 'grade', 'priority', 'enabled', 'fraction', 'action'];
const MERGEABLE_FIELDS = RULE_FIELDS.filter((f) => f !== 'id');

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

function featureKey(material, grade) {
  return material + '::' + grade;
}

function validateDomain(domain) {
  const errors = [];
  if (domain === null || typeof domain !== 'object' || Array.isArray(domain)) {
    throw new ValidationError(['domain must be an object with materials and grades arrays']);
  }
  for (const key of ['materials', 'grades']) {
    const list = domain[key];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`domain.${key} must be a non-empty array`);
      continue;
    }
    const seen = new Set();
    for (const value of list) {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`domain.${key} entries must be non-empty strings`);
        break;
      }
      if (seen.has(value)) {
        errors.push(`domain.${key} contains duplicate value ${JSON.stringify(value)}`);
        break;
      }
      seen.add(value);
    }
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return { materials: [...domain.materials], grades: [...domain.grades] };
}

function featuresOf(domain) {
  const features = [];
  for (const material of domain.materials) {
    for (const grade of domain.grades) {
      features.push({ material, grade });
    }
  }
  return features;
}

function normalizeRules(input, label) {
  const rules = Array.isArray(input) ? input : input && Array.isArray(input.rules) ? input.rules : null;
  if (rules === null) {
    throw new ValidationError([`${label}: expected an array of rules or an object with a rules array`]);
  }
  return rules;
}

function validateRules(input, domain, label) {
  const rules = normalizeRules(input, label);
  const errors = [];
  const ids = new Set();
  rules.forEach((rule, index) => {
    const where = `${label}.rules[${index}]`;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${where}: rule must be an object`);
      return;
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      errors.push(`${where}: id must be a non-empty string`);
    } else if (ids.has(rule.id)) {
      errors.push(`${where}: duplicate rule id ${JSON.stringify(rule.id)}`);
    } else {
      ids.add(rule.id);
    }
    if (typeof rule.material !== 'string' || !domain.materials.includes(rule.material)) {
      errors.push(`${where}: material ${JSON.stringify(rule.material)} is not in the domain`);
    }
    if (typeof rule.grade !== 'string' || !domain.grades.includes(rule.grade)) {
      errors.push(`${where}: grade ${JSON.stringify(rule.grade)} is not in the domain`);
    }
    if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
      errors.push(`${where}: priority must be a finite number`);
    }
    if (typeof rule.enabled !== 'boolean') {
      errors.push(`${where}: enabled must be a boolean`);
    }
    if (typeof rule.fraction !== 'number' || !(rule.fraction >= 0 && rule.fraction <= 1)) {
      errors.push(`${where}: fraction must be a number in [0, 1]`);
    }
    if (typeof rule.action !== 'string' || rule.action.length === 0) {
      errors.push(`${where}: action must be a non-empty string`);
    }
  });
  if (errors.length > 0) throw new ValidationError(errors);
  return rules.map((rule) => {
    const copy = {};
    for (const field of RULE_FIELDS) copy[field] = rule[field];
    return copy;
  });
}

function byId(rules) {
  const map = new Map();
  for (const rule of rules) map.set(rule.id, rule);
  return map;
}

function fieldEqual(a, b) {
  return Object.is(a, b);
}

function rulesEqual(a, b) {
  return MERGEABLE_FIELDS.every((field) => fieldEqual(a[field], b[field]));
}

// Three-way structural merge keyed by rule id, field-level within a rule.
function structuralMerge(base, local, remote) {
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const merged = [];
  const conflicts = [];

  for (const id of [...ids].sort()) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (b && l && r) {
      const mergedRule = { id };
      const fieldConflicts = [];
      for (const field of MERGEABLE_FIELDS) {
        if (fieldEqual(l[field], r[field])) {
          mergedRule[field] = l[field];
        } else if (fieldEqual(b[field], l[field])) {
          mergedRule[field] = r[field];
        } else if (fieldEqual(b[field], r[field])) {
          mergedRule[field] = l[field];
        } else {
          fieldConflicts.push({
            field,
            base: b[field],
            local: l[field],
            remote: r[field],
          });
        }
      }
      if (fieldConflicts.length > 0) {
        conflicts.push({ type: 'field', ruleId: id, fields: fieldConflicts });
      } else {
        merged.push(mergedRule);
      }
    } else if (b && l && !r) {
      if (rulesEqual(b, l)) {
        // deleted on remote, untouched locally -> deleted
      } else {
        conflicts.push({ type: 'delete-vs-modify', ruleId: id, deletedBy: 'remote', base: b, modified: l });
      }
    } else if (b && !l && r) {
      if (rulesEqual(b, r)) {
        // deleted on local, untouched on remote -> deleted
      } else {
        conflicts.push({ type: 'delete-vs-modify', ruleId: id, deletedBy: 'local', base: b, modified: r });
      }
    } else if (b && !l && !r) {
      // deleted on both sides
    } else if (!b && l && r) {
      if (rulesEqual(l, r)) {
        merged.push({ id, ...l });
      } else {
        conflicts.push({ type: 'add-vs-add', ruleId: id, local: l, remote: r });
      }
    } else if (!b && l) {
      merged.push({ id, ...l });
    } else if (!b && r) {
      merged.push({ id, ...r });
    }
  }

  return { merged, conflicts };
}

// Winning rule for a feature: highest priority among enabled rules, ties by id ascending.
function winnerFor(rules, material, grade) {
  let best = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.material !== material || rule.grade !== grade) continue;
    if (
      best === null ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && rule.id < best.id)
    ) {
      best = rule;
    }
  }
  return best;
}

function decisionFor(rules, feature) {
  const winner = winnerFor(rules, feature.material, feature.grade);
  if (winner === null) {
    return { material: feature.material, grade: feature.grade, ruleId: null, action: null, fraction: null };
  }
  return {
    material: feature.material,
    grade: feature.grade,
    ruleId: winner.id,
    action: winner.action,
    fraction: winner.fraction,
  };
}

function decisionsFor(rules, features) {
  return features.map((feature) => decisionFor(rules, feature));
}

// Semantic conflict: for a feature, both sides changed the effective action
// relative to base, and the resulting actions differ.
function semanticConflicts(base, local, remote, features) {
  const conflicts = [];
  for (const feature of features) {
    const baseAction = decisionFor(base, feature).action;
    const localAction = decisionFor(local, feature).action;
    const remoteAction = decisionFor(remote, feature).action;
    const localChanged = !Object.is(localAction, baseAction);
    const remoteChanged = !Object.is(remoteAction, baseAction);
    if (localChanged && remoteChanged && !Object.is(localAction, remoteAction)) {
      conflicts.push({
        type: 'semantic',
        material: feature.material,
        grade: feature.grade,
        baseAction,
        localAction,
        remoteAction,
      });
    }
  }
  return conflicts;
}

function mergeRules({ domain, base, local, remote }) {
  const validDomain = validateDomain(domain);
  const baseRules = validateRules(base, validDomain, 'base');
  const localRules = validateRules(local, validDomain, 'local');
  const remoteRules = validateRules(remote, validDomain, 'remote');

  const features = featuresOf(validDomain);
  const { merged, conflicts: structural } = structuralMerge(baseRules, localRules, remoteRules);
  const semantic = semanticConflicts(baseRules, localRules, remoteRules, features);
  const conflicts = [...structural, ...semantic];
  const decisions = decisionsFor(merged, features);

  return {
    status: conflicts.length === 0 ? 'ok' : 'conflict',
    rules: merged,
    conflicts,
    decisions,
  };
}

module.exports = {
  RULE_FIELDS,
  ValidationError,
  validateDomain,
  validateRules,
  featuresOf,
  structuralMerge,
  winnerFor,
  decisionFor,
  decisionsFor,
  semanticConflicts,
  mergeRules,
  featureKey,
};
