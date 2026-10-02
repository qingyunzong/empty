'use strict';

const { GateError, isRegulatory, EXIT_REGULATORY_DELETED } = require('./policy');
const { readJsonl } = require('./jsonl');

function loadRedactions(filePath) {
  return readJsonl(filePath).filter((entry) => entry && entry.type === 'revoke');
}

// Build Map<principal, Set<field>> of revoked fields.
// Revoking a regulatory field is rejected: regulatory fields must stay visible.
function revokedFields(policy, redactions) {
  const map = new Map();
  for (const entry of redactions) {
    for (const field of entry.fields || []) {
      if (isRegulatory(policy, field)) {
        throw new GateError(
          `regulatory field "${field}" cannot be revoked (regulatory field deleted)`,
          EXIT_REGULATORY_DELETED
        );
      }
      if (!map.has(entry.principal)) map.set(entry.principal, new Set());
      map.get(entry.principal).add(field);
    }
  }
  return map;
}

function isRevoked(revoked, principal, field) {
  return !!revoked && revoked.has(principal) && revoked.get(principal).has(field);
}

module.exports = { loadRedactions, revokedFields, isRevoked };
