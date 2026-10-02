'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Department DAG: edges point from a department to its parents (superiors).
// Authority is inherited downward: a person in dept D may approve requests
// belonging to any dept reachable from D by following child->parent links
// in reverse (i.e. D is an ancestor-or-self of the request dept).
class DeptGraph {
  constructor(parents) {
    if (parents === null || typeof parents !== 'object' || Array.isArray(parents)) {
      throw new Error('departments must be an object mapping dept -> parent array');
    }
    this.parents = new Map();
    for (const [dept, plist] of Object.entries(parents)) {
      if (!Array.isArray(plist)) throw new Error(`parents of ${dept} must be an array`);
      this.parents.set(dept, plist.slice());
    }
    for (const [dept, plist] of this.parents) {
      for (const p of plist) {
        if (!this.parents.has(p)) throw new Error(`unknown parent dept ${p} of ${dept}`);
      }
    }
    const color = new Map();
    const visit = (node) => {
      const c = color.get(node) || 0;
      if (c === 1) throw new Error(`department graph has a cycle at ${node}`);
      if (c === 2) return;
      color.set(node, 1);
      for (const p of this.parents.get(node)) visit(p);
      color.set(node, 2);
    };
    for (const dept of this.parents.keys()) visit(dept);
  }

  departments() {
    return [...this.parents.keys()];
  }

  // Proper ancestors of dept (all depts reachable via parent links).
  ancestors(dept) {
    if (!this.parents.has(dept)) throw new Error(`unknown dept ${dept}`);
    const seen = new Set();
    const stack = [...this.parents.get(dept)];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.parents.get(cur)) stack.push(p);
    }
    return seen;
  }

  isAncestorOrSelf(a, b) {
    return a === b || this.ancestors(b).has(a);
  }
}

const TERMINAL = new Set(['DISBURSED', 'DENIED']);

class Engine {
  constructor(configEvent) {
    if (!configEvent || configEvent.type !== 'config') {
      throw new Error('first event must be a config event');
    }
    this.graph = new DeptGraph(configEvent.departments || {});
    this.people = new Map();
    const people = configEvent.people || {};
    for (const [person, dept] of Object.entries(people)) {
      if (!this.graph.parents.has(dept)) {
        throw new Error(`person ${person} has unknown dept ${dept}`);
      }
      this.people.set(person, dept);
    }
    this.requests = new Map();
    this.transitions = [];
    this.failures = [];
    this.hash = sha256hex('genesis:' + canonical({
      departments: configEvent.departments || {},
      people,
    }));
  }

  _chain(event, outcome) {
    this.hash = sha256hex(this.hash + '|' + canonical(event) + '|' + outcome);
  }

  _fail(event, line, code, reason) {
    this.failures.push({ line, code, reason, event });
    this._chain(event, code);
    return { ok: false, code, reason };
  }

  _ok(event) {
    this._chain(event, 'OK');
    return { ok: true };
  }

  apply(event, line = 0) {
    if (event === null || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.type !== 'string') {
      return this._fail(event, line, 'E_SCHEMA', 'event must be an object with a string type');
    }
    switch (event.type) {
      case 'submit': return this._submit(event, line);
      case 'approve': return this._approve(event, line);
      case 'deny': return this._deny(event, line);
      case 'revoke': return this._revoke(event, line);
      case 'freeze': return this._freeze(event, line);
      case 'unfreeze': return this._unfreeze(event, line);
      default:
        return this._fail(event, line, 'E_SCHEMA', `unknown event type ${event.type}`);
    }
  }

  _getRequest(event, line) {
    if (typeof event.request !== 'string' || event.request.length === 0) {
      this._fail(event, line, 'E_SCHEMA', 'event.request must be a non-empty string');
      return null;
    }
    const req = this.requests.get(event.request);
    if (!req) {
      this._fail(event, line, 'E_UNKNOWN_REQUEST', `unknown request ${event.request}`);
      return null;
    }
    return req;
  }

  _getPerson(event, line, field) {
    const id = event[field];
    if (typeof id !== 'string' || !this.people.has(id)) {
      this._fail(event, line, 'E_UNKNOWN_PERSON', `unknown person in field ${field}`);
      return null;
    }
    return id;
  }

  _evaluate(req, ts, cause) {
    // Priority: compliance freeze > deny > allow(quorum) > pending.
    let next;
    if (req.frozen) next = 'FROZEN';
    else if (req.denials.length > 0) next = 'DENIED';
    else if (req.approvals.length >= 2) next = 'DISBURSED';
    else next = 'PENDING';
    if (next !== req.state) {
      this.transitions.push({ request: req.id, from: req.state, to: next, ts: ts ?? null, cause });
      req.state = next;
    }
  }

  _submit(event, line) {
    if (typeof event.request !== 'string' || event.request.length === 0) {
      return this._fail(event, line, 'E_SCHEMA', 'submit requires a request id');
    }
    if (this.requests.has(event.request)) {
      return this._fail(event, line, 'E_STATE', `request ${event.request} already exists`);
    }
    const by = this._getPerson(event, line, 'by');
    if (by === null) return { ok: false, code: 'E_UNKNOWN_PERSON' };
    if (typeof event.dept !== 'string' || !this.graph.parents.has(event.dept)) {
      return this._fail(event, line, 'E_SCHEMA', `unknown dept ${event.dept}`);
    }
    if (event.amount !== undefined && (typeof event.amount !== 'number' || !(event.amount > 0))) {
      return this._fail(event, line, 'E_SCHEMA', 'amount must be a positive number');
    }
    const req = {
      id: event.request,
      submitter: by,
      dept: event.dept,
      amount: event.amount ?? null,
      ts: event.ts ?? null,
      state: 'NONE',
      approvals: [],
      denials: [],
      revoked: [],
      frozen: false,
    };
    this.requests.set(req.id, req);
    this._evaluate(req, event.ts, `submit:${by}`);
    return this._ok(event);
  }

  _checkVoter(req, event, line, kind) {
    if (TERMINAL.has(req.state)) {
      return this._fail(event, line, 'E_FINAL',
        `request ${req.id} is already ${req.state}; ${kind} has no effect`);
    }
    const by = this._getPerson(event, line, 'by');
    if (by === null) return { ok: false, code: 'E_UNKNOWN_PERSON' };
    const dept = this.people.get(by);
    if (!this.graph.isAncestorOrSelf(dept, req.dept)) {
      return this._fail(event, line, 'E_AUTH',
        `${by} (dept ${dept}) lacks ${kind} authority over dept ${req.dept}`);
    }
    if (by === req.submitter) {
      return this._fail(event, line, 'E_SELF', `submitter ${by} cannot ${kind} own request`);
    }
    return { ok: null, by };
  }

  _approve(event, line) {
    const req = this._getRequest(event, line);
    if (!req) return { ok: false, code: 'E_UNKNOWN_REQUEST' };
    const check = this._checkVoter(req, event, line, 'approve');
    if (check.ok !== null) return check;
    if (req.approvals.some((a) => a.by === check.by)) {
      return this._fail(event, line, 'E_DUPLICATE',
        `${check.by} already approved ${req.id}; duplicate approval is ineffective`);
    }
    req.approvals.push({ by: check.by, ts: event.ts ?? null, held: req.frozen });
    this._evaluate(req, event.ts, `approve:${check.by}`);
    return this._ok(event);
  }

  _deny(event, line) {
    const req = this._getRequest(event, line);
    if (!req) return { ok: false, code: 'E_UNKNOWN_REQUEST' };
    const check = this._checkVoter(req, event, line, 'deny');
    if (check.ok !== null) return check;
    if (req.denials.some((d) => d.by === check.by)) {
      return this._fail(event, line, 'E_DUPLICATE',
        `${check.by} already denied ${req.id}; duplicate denial is ineffective`);
    }
    req.denials.push({
      by: check.by, ts: event.ts ?? null, reason: event.reason ?? null, held: req.frozen,
    });
    this._evaluate(req, event.ts, `deny:${check.by}`);
    return this._ok(event);
  }

  _freeze(event, line) {
    const req = this._getRequest(event, line);
    if (!req) return { ok: false, code: 'E_UNKNOWN_REQUEST' };
    if (TERMINAL.has(req.state)) {
      return this._fail(event, line, 'E_FINAL',
        `request ${req.id} is already ${req.state}; cannot freeze`);
    }
    if (req.frozen) {
      return this._fail(event, line, 'E_STATE', `request ${req.id} is already frozen`);
    }
    req.frozen = true;
    req.freezeReason = event.reason ?? null;
    this._evaluate(req, event.ts, `freeze:${event.by ?? 'compliance'}`);
    return this._ok(event);
  }

  _unfreeze(event, line) {
    const req = this._getRequest(event, line);
    if (!req) return { ok: false, code: 'E_UNKNOWN_REQUEST' };
    if (!req.frozen) {
      return this._fail(event, line, 'E_STATE', `request ${req.id} is not frozen`);
    }
    req.frozen = false;
    const held = [
      ...req.approvals.filter((a) => a.held).map((a) => `approve:${a.by}@${a.ts}`),
      ...req.denials.filter((d) => d.held).map((d) => `deny:${d.by}@${d.ts}`),
    ];
    for (const a of req.approvals) a.held = false;
    for (const d of req.denials) d.held = false;
    const cause = held.length > 0
      ? `unfreeze; held events now effective with original ts: ${held.join(', ')}`
      : 'unfreeze';
    this._evaluate(req, event.ts, cause);
    return this._ok(event);
  }

  _revoke(event, line) {
    const req = this._getRequest(event, line);
    if (!req) return { ok: false, code: 'E_UNKNOWN_REQUEST' };
    if (TERMINAL.has(req.state)) {
      return this._fail(event, line, 'E_FINAL',
        `request ${req.id} is already ${req.state}; approvals can no longer be revoked`);
    }
    const by = this._getPerson(event, line, 'by');
    if (by === null) return { ok: false, code: 'E_UNKNOWN_PERSON' };
    const target = event.target ?? by;
    if (!this.people.has(target)) {
      return this._fail(event, line, 'E_UNKNOWN_PERSON', `unknown revoke target ${target}`);
    }
    const idx = req.approvals.findIndex((a) => a.by === target);
    if (idx === -1) {
      return this._fail(event, line, 'E_NO_APPROVAL',
        `${target} has no approval on ${req.id} to revoke`);
    }
    if (by !== target) {
      const revokerDept = this.people.get(by);
      const targetDept = this.people.get(target);
      if (!this.graph.ancestors(targetDept).has(revokerDept)) {
        return this._fail(event, line, 'E_REVOKE_AUTH',
          `${by} (dept ${revokerDept}) is not a superior of ${target} (dept ${targetDept})`);
      }
    }
    const [removed] = req.approvals.splice(idx, 1);
    req.revoked.push({ target, by, ts: event.ts ?? null, approval_ts: removed.ts });
    this._evaluate(req, event.ts, `revoke:${target}:by:${by}`);
    return this._ok(event);
  }

  finalize() {
    const requests = {};
    for (const req of this.requests.values()) {
      requests[req.id] = {
        state: req.state,
        submitter: req.submitter,
        dept: req.dept,
        amount: req.amount,
        approvals: req.approvals,
        denials: req.denials,
        revoked: req.revoked,
        frozen: req.frozen,
      };
    }
    return {
      requests,
      transitions: this.transitions,
      failures: this.failures,
      audit_hash: this.hash,
    };
  }
}

module.exports = { Engine, DeptGraph, canonical, sha256hex };
