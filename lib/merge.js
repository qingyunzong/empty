'use strict';

const RULE_FIELDS = ['material', 'grade', 'priority', 'enabled', 'fraction', 'action'];

function validateDomain(domain) {
  const errors = [];
  if (typeof domain !== 'object' || domain === null || Array.isArray(domain)) {
    return ['domain must be an object with "materials" and "grades" arrays'];
  }
  for (const key of ['materials', 'grades']) {
    const list = domain[key];
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`domain.${key} must be a non-empty array of strings`);
      continue;
    }
    for (const value of list) {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`domain.${key} entries must be non-empty strings`);
        break;
      }
    }
    if (new Set(list).size !== list.length) {
      errors.push(`domain.${key} must not contain duplicates`);
    }
  }
  return errors;
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

function featureKey(feature) {
  return `${feature.material}/${feature.grade}`;
}

function validateRules(rules, domain, label) {
  const errors = [];
  if (!Array.isArray(rules)) {
    return [`${label}: rules must be an array`];
  }
  const seen = new Set();
  rules.forEach((rule, index) => {
    const at = `${label}[${index}]`;
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      errors.push(`${at}: rule must be an object`);
      return;
    }
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      errors.push(`${at}: id must be a non-empty string`);
    } else if (seen.has(rule.id)) {
      errors.push(`${at}: duplicate rule id "${rule.id}"`);
    } else {
      seen.add(rule.id);
    }
    if (!domain.materials.includes(rule.material)) {
      errors.push(`${at}: material ${JSON.stringify(rule.material)} is not in the domain`);
    }
    if (!domain.grades.includes(rule.grade)) {
      errors.push(`${at}: grade ${JSON.stringify(rule.grade)} is not in the domain`);
    }
    if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
      errors.push(`${at}: priority must be a finite number`);
    }
    if (typeof rule.enabled !== 'boolean') {
      errors.push(`${at}: enabled must be a boolean`);
    }
    if (typeof rule.fraction !== 'number' || !(rule.fraction >= 0 && rule.fraction <= 1)) {
      errors.push(`${at}: fraction must be a number in [0, 1]`);
    }
    if (typeof rule.action !== 'string' || rule.action.length === 0) {
      errors.push(`${at}: action must be a non-empty string`);
    }
  });
  return errors;
}

function decide(rules, feature) {
  let best = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.material !== feature.material || rule.grade !== feature.grade) continue;
    if (
      best === null ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && rule.id < best.id)
    ) {
      best = rule;
    }
  }
  return best === null ? null : { ruleId: best.id, action: best.action };
}

function rulesEqual(a, b) {
  return RULE_FIELDS.every((field) => a[field] === b[field]);
}

function byId(rules) {
  const map = new Map();
  for (const rule of rules) map.set(rule.id, rule);
  return map;
}

function mergeRules(base, local, remote) {
  const conflicts = [];
  const merged = [];
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const ids = [...new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])].sort();

  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (b === undefined) {
      if (l !== undefined && r !== undefined) {
        if (rulesEqual(l, r)) {
          merged.push({ id, ...l });
        } else {
          conflicts.push({ type: 'add-add', ruleId: id, local: l, remote: r });
        }
      } else {
        merged.push({ id, ...(l !== undefined ? l : r) });
      }
      continue;
    }

    const localDeleted = l === undefined;
    const remoteDeleted = r === undefined;
    if (localDeleted && remoteDeleted) continue;
    if (localDeleted || remoteDeleted) {
      const survivor = localDeleted ? r : l;
      if (rulesEqual(survivor, b)) continue;
      conflicts.push({
        type: 'delete-modify',
        ruleId: id,
        deletedBy: localDeleted ? 'local' : 'remote',
        modified: survivor,
        base: b,
      });
      continue;
    }

    const result = { id };
    const fieldConflicts = [];
    for (const field of RULE_FIELDS) {
      const localChanged = l[field] !== b[field];
      const remoteChanged = r[field] !== b[field];
      if (!localChanged && !remoteChanged) {
        result[field] = b[field];
      } else if (!localChanged) {
        result[field] = r[field];
      } else if (!remoteChanged) {
        result[field] = l[field];
      } else if (l[field] === r[field]) {
        result[field] = l[field];
      } else {
        fieldConflicts.push({ field, base: b[field], local: l[field], remote: r[field] });
      }
    }
    if (fieldConflicts.length > 0) {
      conflicts.push({ type: 'field', ruleId: id, fields: fieldConflicts });
    } else {
      merged.push(result);
    }
  }

  return { rules: merged, conflicts };
}

function semanticConflicts(base, local, remote, features) {
  const conflicts = [];
  for (const feature of features) {
    const baseDecision = decide(base, feature);
    const localDecision = decide(local, feature);
    const remoteDecision = decide(remote, feature);
    const baseAction = baseDecision === null ? null : baseDecision.action;
    const localAction = localDecision === null ? null : localDecision.action;
    const remoteAction = remoteDecision === null ? null : remoteDecision.action;
    if (
      localAction !== baseAction &&
      remoteAction !== baseAction &&
      localAction !== remoteAction
    ) {
      conflicts.push({
        type: 'semantic',
        feature: featureKey(feature),
        base: baseDecision,
        local: localDecision,
        remote: remoteDecision,
      });
    }
  }
  return conflicts;
}

function mergeAll(domain, base, local, remote) {
  const features = featuresOf(domain);
  const structural = mergeRules(base, local, remote);
  const semantic = semanticConflicts(base, local, remote, features);
  const decisions = {};
  for (const feature of features) {
    decisions[featureKey(feature)] = decide(structural.rules, feature);
  }
  return {
    rules: structural.rules,
    conflicts: [...structural.conflicts, ...semantic],
    decisions,
  };
}

module.exports = {
  RULE_FIELDS,
  validateDomain,
  validateRules,
  featuresOf,
  featureKey,
  decide,
  mergeRules,
  semanticConflicts,
  mergeAll,
};
