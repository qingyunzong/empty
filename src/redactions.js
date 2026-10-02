import { GateError, EXIT_REGULATORY_FIELD_DELETED, isRegulatory } from './policy.js';

export function parseRedactions(text) {
  const redactions = [];
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new GateError(`redactions.jsonl line ${index + 1}: invalid JSON`, 1);
    }
    if (typeof entry.action !== 'string' || typeof entry.field !== 'string') {
      throw new GateError(`redactions.jsonl line ${index + 1}: needs action and field`, 1);
    }
    redactions.push(entry);
  }
  return redactions;
}

// A regulatory (forced) field can never be revoked or deleted.
export function checkRedactions(policy, redactions) {
  for (const entry of redactions) {
    if ((entry.action === 'revoke' || entry.action === 'delete') && isRegulatory(policy, entry.field)) {
      throw new GateError(
        `regulatory field '${entry.field}' cannot be ${entry.action}d`,
        EXIT_REGULATORY_FIELD_DELETED,
      );
    }
  }
}

export function isRevoked(redactions, audienceId, field) {
  return redactions.some(
    (entry) =>
      (entry.action === 'revoke' || entry.action === 'delete') &&
      entry.field === field &&
      (entry.audience === '*' || entry.audience === audienceId),
  );
}
