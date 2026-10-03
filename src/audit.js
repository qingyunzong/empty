'use strict';

const crypto = require('node:crypto');

class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

// Deterministic canonical serialization: object keys sorted recursively.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
    '}'
  );
}

function hashEntries(entries) {
  return crypto.createHash('sha256').update(canonicalize(entries), 'utf8').digest('hex');
}

class AuditLog {
  constructor() {
    this.entries = []; // append-only, immutable after commit
    this.byId = new Map();
  }

  static fromCommands(commands) {
    const log = new AuditLog();
    for (const cmd of commands) log.apply(cmd);
    return log;
  }

  apply(cmd) {
    if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) {
      throw new AuditError('E_INVALID_COMMAND', 'command must be a JSON object');
    }
    switch (cmd.op) {
      case 'append':
        return this.#append(cmd);
      case 'revoke':
        return this.#revoke(cmd);
      default:
        throw new AuditError('E_UNKNOWN_OP', `unknown op: ${String(cmd.op)}`);
    }
  }

  #checkCommon(cmd) {
    if (typeof cmd.id !== 'string' || cmd.id.length === 0) {
      throw new AuditError('E_INVALID_ID', 'command id must be a non-empty string');
    }
    if (this.byId.has(cmd.id)) {
      throw new AuditError('E_DUPLICATE_ID', `duplicate entry id: ${cmd.id}`);
    }
    if (!Number.isFinite(cmd.ts)) {
      throw new AuditError('E_INVALID_TS', `entry ${cmd.id}: ts must be a finite number`);
    }
  }

  #append(cmd) {
    this.#checkCommon(cmd);
    const entry = {
      id: cmd.id,
      ts: cmd.ts,
      op: 'append',
      data: cmd.data === undefined ? null : cmd.data,
    };
    this.#commit(entry);
    return entry;
  }

  #revoke(cmd) {
    this.#checkCommon(cmd);
    if (typeof cmd.targetId !== 'string' || cmd.targetId.length === 0) {
      throw new AuditError('E_INVALID_TARGET', `revoke ${cmd.id}: targetId must be a non-empty string`);
    }
    // Cycle check: follow the revoke chain from the target; reaching the new
    // id means this revoke would close a loop.
    let cur = cmd.targetId;
    const seen = new Set();
    while (cur !== undefined) {
      if (cur === cmd.id) {
        throw new AuditError('E_REVOKE_CYCLE', `revoke ${cmd.id} would create a revoke cycle`);
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      const e = this.byId.get(cur);
      cur = e && e.op === 'revoke' ? e.targetId : undefined;
    }
    const entry = { id: cmd.id, ts: cmd.ts, op: 'revoke', targetId: cmd.targetId };
    this.#commit(entry);
    return entry;
  }

  #commit(entry) {
    this.entries.push(Object.freeze(entry));
    this.byId.set(entry.id, entry);
  }

  // View of the log as of time t (entries with ts > t are hidden).
  // A revoke hides its target; a revoke that is itself revoked by an active
  // revoke is inactive, so its effect is undone (cascade by revoke order).
  viewAt(t) {
    const asOf = t === undefined ? Infinity : t;
    if (!Number.isFinite(asOf) && asOf !== Infinity) {
      throw new AuditError('E_INVALID_AS_OF', 'asOf must be a finite number');
    }
    const present = this.entries.filter((e) => e.ts <= asOf);

    const revokersByTarget = new Map();
    for (const e of present) {
      if (e.op !== 'revoke') continue;
      let list = revokersByTarget.get(e.targetId);
      if (!list) revokersByTarget.set(e.targetId, (list = []));
      list.push(e);
    }

    // A revoke is active iff it is present and not itself revoked by an
    // active revoke. Cycles are rejected at insert time; the visiting set is
    // a defensive re-check.
    const activeCache = new Map();
    const visiting = new Set();
    const isActive = (r) => {
      const cached = activeCache.get(r.id);
      if (cached !== undefined) return cached;
      if (visiting.has(r.id)) {
        throw new AuditError('E_REVOKE_CYCLE', `revoke cycle detected at ${r.id}`);
      }
      visiting.add(r.id);
      const revokers = revokersByTarget.get(r.id) || [];
      const active = !revokers.some(isActive);
      visiting.delete(r.id);
      activeCache.set(r.id, active);
      return active;
    };

    // Resolve which active revoke hides each entry; ties broken by earliest
    // revoke (ts, then log order).
    const hiddenBy = new Map(); // entry id -> revoker id
    for (const e of present) {
      const revokers = (revokersByTarget.get(e.id) || []).filter((r) => isActive(r));
      if (revokers.length === 0) continue;
      revokers.sort((a, b) => a.ts - b.ts || this.entries.indexOf(a) - this.entries.indexOf(b));
      hiddenBy.set(e.id, revokers[0].id);
    }

    const visible = [];
    const hidden = [];
    for (const e of this.entries) {
      if (e.ts > asOf) {
        hidden.push({ id: e.id, reason: 'after_as_of' });
      } else if (hiddenBy.has(e.id)) {
        hidden.push({ id: e.id, reason: `revoked_by:${hiddenBy.get(e.id)}` });
      } else {
        visible.push(e);
      }
    }

    return {
      asOf: asOf === Infinity ? null : asOf,
      visible,
      hidden,
      hash: hashEntries(visible),
    };
  }

  hashAt(t) {
    return this.viewAt(t).hash;
  }
}

module.exports = { AuditLog, AuditError, canonicalize, hashEntries };
