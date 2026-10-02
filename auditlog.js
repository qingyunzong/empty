'use strict';

const crypto = require('node:crypto');

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function hashVisible(visibleEntries) {
  return crypto.createHash('sha256').update(canonicalize(visibleEntries), 'utf8').digest('hex');
}

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new AuditError('E_SCHEMA', `entry id must be a non-empty string, got ${JSON.stringify(id)}`);
  }
}

function assertTime(t) {
  if (!Number.isInteger(t) || t < 0) {
    throw new AuditError('E_SCHEMA', `entry t must be a non-negative integer, got ${JSON.stringify(t)}`);
  }
}

class AuditLog {
  constructor() {
    this.entries = [];
    this.byId = new Map();
    this.revokesByTarget = new Map();
  }

  addAppend({ id, t, data = {} }) {
    this._checkIdAndTime(id, t);
    const entry = { op: 'append', id, t, data };
    this._commit(entry);
    return entry;
  }

  addRevoke({ id, t, targetId }) {
    this._checkIdAndTime(id, t);
    assertId(targetId);
    this._assertNoCycle(id, targetId);
    const entry = { op: 'revoke', id, t, targetId };
    this._commit(entry);
    return entry;
  }

  _checkIdAndTime(id, t) {
    assertId(id);
    assertTime(t);
    if (this.byId.has(id)) {
      throw new AuditError('E_DUPLICATE_ID', `duplicate entry id ${JSON.stringify(id)}`);
    }
    const last = this.entries[this.entries.length - 1];
    if (last && t <= last.t) {
      throw new AuditError('E_ORDER', `entry t=${t} is not after previous t=${last.t}; log time must be strictly increasing`);
    }
  }

  // Follow the revoke -> target chain starting at targetId. Reaching the new
  // entry's id means the new edge would close a cycle.
  _assertNoCycle(id, targetId) {
    let cur = targetId;
    const seen = new Set();
    for (;;) {
      if (cur === id || seen.has(cur)) {
        throw new AuditError('E_REVOKE_CYCLE', `revoke ${JSON.stringify(id)} -> ${JSON.stringify(targetId)} would close a revoke cycle`);
      }
      seen.add(cur);
      const entry = this.byId.get(cur);
      if (!entry || entry.op !== 'revoke') return;
      cur = entry.targetId;
    }
  }

  _commit(entry) {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    if (entry.op === 'revoke') {
      if (!this.revokesByTarget.has(entry.targetId)) {
        this.revokesByTarget.set(entry.targetId, []);
      }
      this.revokesByTarget.get(entry.targetId).push(entry);
    }
  }

  // A revoke is effective at asOf when it is present (t <= asOf) and not
  // itself hidden by an effective revoke. An entry is hidden when at least
  // one effective revoke targets it. Resolution cascades along revoke chains.
  computeView(asOf) {
    assertTime(asOf);
    const memo = new Map();
    const visiting = new Set();
    const isEffective = (revoke) => {
      if (memo.has(revoke.id)) return memo.get(revoke.id);
      if (visiting.has(revoke.id)) {
        throw new AuditError('E_REVOKE_CYCLE', `revoke cycle detected involving ${JSON.stringify(revoke.id)}`);
      }
      visiting.add(revoke.id);
      let effective = true;
      for (const up of this.revokesByTarget.get(revoke.id) || []) {
        if (up.t <= asOf && isEffective(up)) {
          effective = false;
          break;
        }
      }
      visiting.delete(revoke.id);
      memo.set(revoke.id, effective);
      return effective;
    };

    const visible = [];
    const hidden = [];
    for (const entry of this.entries) {
      if (entry.t > asOf) {
        hidden.push({ id: entry.id, reason: 'after-as-of' });
        continue;
      }
      let revokedBy = null;
      for (const revoke of this.revokesByTarget.get(entry.id) || []) {
        if (revoke.t <= asOf && isEffective(revoke)) {
          revokedBy = revoke.id;
          break;
        }
      }
      if (revokedBy !== null) {
        hidden.push({ id: entry.id, reason: 'revoked', by: revokedBy });
      } else {
        visible.push(entry);
      }
    }
    return { asOf, visible, hidden, hash: hashVisible(visible) };
  }
}

function applyCommand(log, cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
    throw new AuditError('E_SCHEMA', `command must be a JSON object, got ${JSON.stringify(cmd)}`);
  }
  switch (cmd.op) {
    case 'append':
      log.addAppend(cmd);
      return null;
    case 'revoke':
      log.addRevoke(cmd);
      return null;
    case 'asOf':
      return { view: log.computeView(cmd.t) };
    default:
      throw new AuditError('E_UNKNOWN_OP', `unknown op ${JSON.stringify(cmd.op)}`);
  }
}

module.exports = { AuditLog, AuditError, applyCommand, canonicalize, hashVisible };
