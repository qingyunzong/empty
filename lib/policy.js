'use strict';

const { PolicyError } = require('./errors');
const { reaches } = require('./graph');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value) {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    isNonEmptyString(value)
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Splits text into parsed JSONL records: [{ value, line }].
// Blank lines are skipped. Line numbers are 1-based.
function parseJsonl(text, label) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let value;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      throw new PolicyError('E_PARSE', i + 1, `${label}:${i + 1}: invalid JSON`);
    }
    records.push({ value, line: i + 1 });
  }
  return records;
}

// policy.jsonl record kinds:
//   {"type":"role","role":"viewer"}                         (optional declaration)
//   {"type":"inherit","role":"analyst","inherits":"viewer"} analyst inherits viewer
//   {"type":"rule","id":"r1","role":"viewer","resource":"settlement:read","effect":"allow"}
//   {"type":"revoke","role":"intern","at":1700000000}       revokes role's rules at/after ts
function loadPolicy(text) {
  const records = parseJsonl(text, 'policy');
  const adj = new Map(); // role -> Set of parents
  const rules = [];
  const revocations = [];
  const roles = new Set();
  const ruleIds = new Set();

  const addEdge = (role, parent) => {
    if (!adj.has(role)) adj.set(role, new Set());
    adj.get(role).add(parent);
  };

  for (const { value, line } of records) {
    if (!isPlainObject(value) || typeof value.type !== 'string') {
      throw new PolicyError('E_SCHEMA', line, `policy:${line}: record must be an object with a type`);
    }
    switch (value.type) {
      case 'role': {
        if (!isNonEmptyString(value.role)) {
          throw new PolicyError('E_SCHEMA', line, `policy:${line}: role record needs a role string`);
        }
        roles.add(value.role);
        break;
      }
      case 'inherit': {
        if (!isNonEmptyString(value.role) || !isNonEmptyString(value.inherits)) {
          throw new PolicyError('E_SCHEMA', line, `policy:${line}: inherit needs role and inherits strings`);
        }
        // Adding role -> inherits closes a cycle iff role is already
        // reachable from inherits (or they are equal).
        if (reaches(adj, value.inherits, value.role)) {
          throw new PolicyError('E_CYCLE', line, `policy:${line}: inheritance cycle via "${value.role}"`);
        }
        addEdge(value.role, value.inherits);
        roles.add(value.role);
        roles.add(value.inherits);
        break;
      }
      case 'rule': {
        if (
          !isNonEmptyString(value.id) ||
          !isNonEmptyString(value.role) ||
          !isNonEmptyString(value.resource) ||
          (value.effect !== 'allow' && value.effect !== 'deny')
        ) {
          throw new PolicyError('E_SCHEMA', line, `policy:${line}: rule needs id, role, resource and effect allow|deny`);
        }
        if (ruleIds.has(value.id)) {
          throw new PolicyError('E_SCHEMA', line, `policy:${line}: duplicate rule id "${value.id}"`);
        }
        ruleIds.add(value.id);
        rules.push({
          id: value.id,
          role: value.role,
          resource: value.resource,
          effect: value.effect,
        });
        roles.add(value.role);
        break;
      }
      case 'revoke': {
        if (!isNonEmptyString(value.role) || !isTimestamp(value.at)) {
          throw new PolicyError('E_SCHEMA', line, `policy:${line}: revoke needs role and at (number|string)`);
        }
        revocations.push({ role: value.role, at: value.at });
        roles.add(value.role);
        break;
      }
      default:
        throw new PolicyError('E_SCHEMA', line, `policy:${line}: unknown record type "${value.type}"`);
    }
  }

  return { adj, rules, revocations, roles };
}

// events.jsonl record kind:
//   {"type":"authorize","id":"e1","role":"analyst","resource":"settlement:read","ts":1700000000}
function loadEvents(text) {
  const records = parseJsonl(text, 'events');
  const events = [];
  for (const { value, line } of records) {
    if (
      !isPlainObject(value) ||
      value.type !== 'authorize' ||
      !isNonEmptyString(value.id) ||
      !isNonEmptyString(value.role) ||
      !isNonEmptyString(value.resource) ||
      !isTimestamp(value.ts)
    ) {
      throw new PolicyError('E_SCHEMA', line, `events:${line}: authorize event needs id, role, resource and ts`);
    }
    events.push({
      id: value.id,
      role: value.role,
      resource: value.resource,
      ts: value.ts,
    });
  }
  return events;
}

module.exports = { loadPolicy, loadEvents, parseJsonl };
