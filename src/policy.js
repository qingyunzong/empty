'use strict';

const fs = require('node:fs');

const EXIT_UNKNOWN_CLASSIFICATION = 28;
const EXIT_HASH_INPUT_MISSING = 29;
const EXIT_REGULATORY_DELETED = 30;

class GateError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'GateError';
    this.exitCode = exitCode;
  }
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new GateError('policy must be an object', 2);
  }
  const classifications = policy.classifications || {};
  for (const [name, level] of Object.entries(classifications)) {
    if (!Number.isInteger(level) || level < 0) {
      throw new GateError(`classification "${name}" has invalid level`, EXIT_UNKNOWN_CLASSIFICATION);
    }
  }
  const labels = policy.labels || {};
  for (const [label, def] of Object.entries(labels)) {
    if (def && def.upgradeTo !== undefined && !(def.upgradeTo in classifications)) {
      throw new GateError(
        `label "${label}" upgrades to unknown classification "${def.upgradeTo}"`,
        EXIT_UNKNOWN_CLASSIFICATION
      );
    }
  }
  for (const [field, def] of Object.entries(policy.fields || {})) {
    if (!def || typeof def !== 'object') {
      throw new GateError(`field "${field}" has invalid definition`, 2);
    }
    if (!(def.classification in classifications)) {
      throw new GateError(
        `field "${field}" has unknown classification "${def.classification}"`,
        EXIT_UNKNOWN_CLASSIFICATION
      );
    }
    for (const label of def.labels || []) {
      if (!(label in labels)) {
        throw new GateError(`field "${field}" references unknown label "${label}"`, EXIT_UNKNOWN_CLASSIFICATION);
      }
    }
  }
  for (const [scope, table] of [['org', policy.orgs], ['role', policy.roles], ['individual', policy.individuals]]) {
    for (const [name, def] of Object.entries(table || {})) {
      if (def.clearance !== undefined && !(def.clearance in classifications)) {
        throw new GateError(
          `${scope} "${name}" has unknown clearance classification "${def.clearance}"`,
          EXIT_UNKNOWN_CLASSIFICATION
        );
      }
    }
  }
  for (const [role, def] of Object.entries(policy.roles || {})) {
    if (!(policy.orgs || {})[def.org]) {
      throw new GateError(`role "${role}" references unknown org "${def.org}"`, 2);
    }
  }
  for (const [name, def] of Object.entries(policy.individuals || {})) {
    if (!(policy.roles || {})[def.role]) {
      throw new GateError(`individual "${name}" references unknown role "${def.role}"`, 2);
    }
  }
}

function parsePolicy(raw) {
  const policy = JSON.parse(raw);
  validatePolicy(policy);
  return policy;
}

function loadPolicy(filePath) {
  return parsePolicy(fs.readFileSync(filePath, 'utf8'));
}

function classificationLevel(policy, name) {
  const level = (policy.classifications || {})[name];
  if (level === undefined) {
    throw new GateError(`unknown classification "${name}"`, EXIT_UNKNOWN_CLASSIFICATION);
  }
  return level;
}

function fieldDef(policy, field) {
  return (policy.fields || {})[field] || null;
}

// Data classification labels can force-upgrade a field's effective level.
function effectiveClassificationLevel(policy, field) {
  const def = fieldDef(policy, field);
  if (!def) return null;
  let level = classificationLevel(policy, def.classification);
  for (const label of def.labels || []) {
    const up = (policy.labels || {})[label];
    if (up && up.upgradeTo !== undefined) {
      level = Math.max(level, classificationLevel(policy, up.upgradeTo));
    }
  }
  return level;
}

function isRegulatory(policy, field) {
  const def = fieldDef(policy, field);
  if (!def) return false;
  if (def.regulatory === true) return true;
  return (def.labels || []).some((label) => {
    const l = (policy.labels || {})[label];
    return l && l.regulatory === true;
  });
}

function hasLabel(policy, field, label) {
  const def = fieldDef(policy, field);
  return !!def && (def.labels || []).includes(label);
}

module.exports = {
  GateError,
  EXIT_UNKNOWN_CLASSIFICATION,
  EXIT_HASH_INPUT_MISSING,
  EXIT_REGULATORY_DELETED,
  parsePolicy,
  loadPolicy,
  validatePolicy,
  classificationLevel,
  effectiveClassificationLevel,
  isRegulatory,
  hasLabel,
  fieldDef,
};
