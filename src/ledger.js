'use strict';

const crypto = require('node:crypto');

class StructuralError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StructuralError';
    this.code = code;
  }
}

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function requireFields(event, fields) {
  for (const field of fields) {
    if (event[field] === undefined || event[field] === null) {
      throw new StructuralError('E_FIELD', `event "${event.type}" missing field "${field}"`);
    }
  }
}

class DepartmentGraph {
  constructor() {
    this.parents = new Map();
  }

  add(dept, parents = []) {
    if (this.parents.has(dept)) {
      throw new StructuralError('E_DEPT_EXISTS', `department already exists: ${dept}`);
    }
    for (const parent of parents) {
      if (!this.parents.has(parent)) {
        throw new StructuralError('E_UNKNOWN_DEPT', `unknown parent department: ${parent}`);
      }
    }
    this.parents.set(dept, new Set(parents));
  }

  has(dept) {
    return this.parents.has(dept);
  }

  ancestorsOf(dept) {
    if (!this.parents.has(dept)) {
      throw new StructuralError('E_UNKNOWN_DEPT', `unknown department: ${dept}`);
    }
    const seen = new Set([dept]);
    const queue = [dept];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const parent of this.parents.get(current)) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return seen;
  }

  isAncestorOrSelf(maybeAncestor, dept) {
    return this.parents.has(maybeAncestor) && this.ancestorsOf(dept).has(maybeAncestor);
  }
}

function evaluate(req) {
  const effective = [...req.approvals.values()].filter((a) => a.effective);
  if (effective.some((a) => a.decision === 'deny')) return 'REJECTED';
  const allowApprovers = new Set(
    effective.filter((a) => a.decision === 'allow').map((a) => a.approver)
  );
  if (allowApprovers.size >= 2) return 'DISBURSED';
  return 'PENDING';
}

class Ledger {
  constructor() {
    this.depts = new DepartmentGraph();
    this.members = new Map();
    this.requests = new Map();
    this.transitions = [];
    this.hash = sha256('escrow-ledger-genesis');
    this.seq = 0;
  }

  apply(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new StructuralError('E_EVENT', 'event must be a JSON object');
    }
    if (typeof event.type !== 'string') {
      throw new StructuralError('E_EVENT_TYPE', 'event missing string field "type"');
    }
    const seq = this.seq++;
    const ts = event.ts === undefined ? seq : event.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new StructuralError('E_FIELD', 'field "ts" must be a finite number');
    }
    let result;
    try {
      result = this.dispatch(event, ts, seq);
    } catch (err) {
      if (err instanceof BusinessError) {
        result = { ok: false, error: err.code, message: err.message, request: event.request };
      } else {
        throw err;
      }
    }
    const transition = { seq, ts, event, ...result };
    this.hash = sha256(
      this.hash +
        '\n' +
        canonical(event) +
        '\n' +
        canonical({
          ok: result.ok,
          error: result.error ?? null,
          request: result.request ?? null,
          to: result.to ?? null,
        })
    );
    transition.hash = this.hash;
    this.transitions.push(transition);
    return transition;
  }

  dispatch(event, ts, seq) {
    switch (event.type) {
      case 'add_dept': {
        requireFields(event, ['dept']);
        const parents = event.parents ?? [];
        if (!Array.isArray(parents)) {
          throw new StructuralError('E_FIELD', 'field "parents" must be an array');
        }
        this.depts.add(event.dept, parents);
        return { ok: true };
      }
      case 'add_member': {
        requireFields(event, ['member', 'dept']);
        if (this.members.has(event.member)) {
          throw new StructuralError('E_MEMBER_EXISTS', `member already exists: ${event.member}`);
        }
        if (!this.depts.has(event.dept)) {
          throw new StructuralError('E_UNKNOWN_DEPT', `unknown department: ${event.dept}`);
        }
        const role = event.role ?? 'staff';
        if (role !== 'staff' && role !== 'compliance') {
          throw new StructuralError('E_FIELD', `unknown role: ${role}`);
        }
        this.members.set(event.member, { id: event.member, dept: event.dept, role });
        return { ok: true };
      }
      case 'submit':
        return this.onSubmit(event);
      case 'approve':
        return this.onApprove(event, ts, seq);
      case 'freeze':
        return this.onFreeze(event);
      case 'unfreeze':
        return this.onUnfreeze(event);
      case 'revoke':
        return this.onRevoke(event);
      default:
        throw new StructuralError('E_EVENT_TYPE', `unknown event type: ${event.type}`);
    }
  }

  getRequest(id) {
    const req = this.requests.get(id);
    if (!req) throw new StructuralError('E_UNKNOWN_REQUEST', `unknown request: ${id}`);
    return req;
  }

  getMember(id) {
    const member = this.members.get(id);
    if (!member) throw new StructuralError('E_UNKNOWN_MEMBER', `unknown member: ${id}`);
    return member;
  }

  onSubmit(event) {
    requireFields(event, ['request', 'submitter', 'dept']);
    if (this.requests.has(event.request)) {
      throw new BusinessError('E_REQUEST_EXISTS', `request already exists: ${event.request}`);
    }
    this.getMember(event.submitter);
    if (!this.depts.has(event.dept)) {
      throw new StructuralError('E_UNKNOWN_DEPT', `unknown department: ${event.dept}`);
    }
    const req = {
      id: event.request,
      dept: event.dept,
      submitter: event.submitter,
      amount: event.amount ?? null,
      state: 'PENDING',
      frozen: false,
      approvals: new Map(),
    };
    this.requests.set(req.id, req);
    return { ok: true, request: req.id, from: null, to: 'PENDING' };
  }

  onApprove(event, ts, seq) {
    requireFields(event, ['request', 'approver', 'decision']);
    const req = this.getRequest(event.request);
    const member = this.getMember(event.approver);
    if (event.decision !== 'allow' && event.decision !== 'deny') {
      throw new StructuralError('E_FIELD', `decision must be "allow" or "deny": ${event.decision}`);
    }
    if (req.state === 'DISBURSED') {
      throw new BusinessError('E_FINAL', `request ${req.id} already disbursed; approval rejected`);
    }
    if (req.state === 'REJECTED') {
      throw new BusinessError('E_STATE', `request ${req.id} already rejected; approval rejected`);
    }
    if (!this.depts.isAncestorOrSelf(member.dept, req.dept)) {
      throw new BusinessError(
        'E_AUTHORITY',
        `approver ${member.id} (dept ${member.dept}) has no authority over dept ${req.dept}`
      );
    }
    if (req.approvals.has(event.approver)) {
      throw new BusinessError(
        'E_DUPLICATE',
        `approver ${event.approver} already approved request ${req.id}`
      );
    }
    const from = req.state;
    const effective = !req.frozen;
    req.approvals.set(event.approver, {
      approver: event.approver,
      decision: event.decision,
      ts,
      seq,
      effective,
    });
    if (effective) req.state = evaluate(req);
    return { ok: true, request: req.id, from, to: req.state, effective };
  }

  onFreeze(event) {
    requireFields(event, ['request', 'by']);
    const req = this.getRequest(event.request);
    const member = this.getMember(event.by);
    if (member.role !== 'compliance') {
      throw new BusinessError('E_AUTHORITY', `freeze requires compliance role, got ${member.id}`);
    }
    if (req.state === 'DISBURSED') {
      throw new BusinessError('E_FINAL', `request ${req.id} already disbursed; cannot freeze`);
    }
    if (req.frozen) {
      throw new BusinessError('E_STATE', `request ${req.id} is already frozen`);
    }
    req.frozen = true;
    return { ok: true, request: req.id, from: req.state, to: req.state, frozen: true };
  }

  onUnfreeze(event) {
    requireFields(event, ['request', 'by']);
    const req = this.getRequest(event.request);
    const member = this.getMember(event.by);
    if (member.role !== 'compliance') {
      throw new BusinessError('E_AUTHORITY', `unfreeze requires compliance role, got ${member.id}`);
    }
    if (!req.frozen) {
      throw new BusinessError('E_STATE', `request ${req.id} is not frozen`);
    }
    req.frozen = false;
    const pending = [...req.approvals.values()]
      .filter((a) => !a.effective)
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    for (const approval of pending) approval.effective = true;
    const from = req.state;
    req.state = evaluate(req);
    return {
      ok: true,
      request: req.id,
      from,
      to: req.state,
      frozen: false,
      activated: pending.map((a) => a.approver),
    };
  }

  onRevoke(event) {
    requireFields(event, ['request', 'approver', 'by']);
    const req = this.getRequest(event.request);
    if (req.state === 'DISBURSED') {
      throw new BusinessError('E_FINAL', `request ${req.id} already disbursed; cannot revoke`);
    }
    const target = req.approvals.get(event.approver);
    if (!target) {
      throw new BusinessError(
        'E_NOT_FOUND',
        `no approval by ${event.approver} on request ${req.id}`
      );
    }
    const byMember = this.getMember(event.by);
    const targetMember = this.getMember(event.approver);
    const isSelf = event.by === event.approver;
    const isSuperior =
      byMember.dept !== targetMember.dept &&
      this.depts.ancestorsOf(targetMember.dept).has(byMember.dept);
    if (!isSelf && !isSuperior) {
      throw new BusinessError(
        'E_AUTHORITY',
        `${event.by} is neither ${event.approver} nor a superior; cannot revoke`
      );
    }
    req.approvals.delete(event.approver);
    const from = req.state;
    req.state = evaluate(req);
    return { ok: true, request: req.id, from, to: req.state, revoked: event.approver };
  }

  report() {
    const requests = {};
    for (const [id, req] of this.requests) {
      requests[id] = {
        state: req.state,
        dept: req.dept,
        submitter: req.submitter,
        amount: req.amount,
        frozen: req.frozen,
        approvals: [...req.approvals.values()].map((a) => ({
          approver: a.approver,
          decision: a.decision,
          ts: a.ts,
          effective: a.effective,
        })),
      };
    }
    return { requests, transitions: this.transitions, auditHash: this.hash };
  }
}

module.exports = {
  Ledger,
  DepartmentGraph,
  StructuralError,
  BusinessError,
  canonical,
  sha256,
};
