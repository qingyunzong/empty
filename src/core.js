'use strict';

const crypto = require('node:crypto');
const { plan } = require('./scheduler');

const GENESIS = '0'.repeat(64);

class AuditError extends Error {
  constructor(code, message, exitCode = 8) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const DEFAULT_CONFIG = {
  deptQuota: 0.5,        // max share of one department per assign run
  highRiskThreshold: 70, // risk >= threshold counts as high risk
  agingRate: 2,          // effective-risk points gained per tick spent waiting
  creditWeight: 1,       // effective-risk points per compensation credit
  preemptCredit: 15,     // credits granted when preempted by a higher-risk case
};

function createState(config = {}) {
  return {
    config: { ...DEFAULT_CONFIG, ...config },
    now: 0,
    reviewers: {},
    cases: {},
    events: [],
    certificate: GENESIS,
  };
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

// Concurrent events are judged by (logical time, source, case ID).
function eventOrder(a, b) {
  return (
    a.time - b.time ||
    String(a.source).localeCompare(String(b.source)) ||
    String(a.caseId).localeCompare(String(b.caseId)) ||
    a.seq - b.seq
  );
}

function recomputeCertificate(events) {
  let cert = GENESIS;
  for (const e of [...events].sort(eventOrder)) {
    // seq is a storage tie-breaker only; identity is (time, source, caseId, type, data).
    const { seq, ...identity } = e;
    cert = crypto.createHash('sha256').update(cert + '|' + canonical(identity)).digest('hex');
  }
  return cert;
}

function finalize(state) {
  state.certificate = recomputeCertificate(state.events);
  return state;
}

function record(state, meta, caseId, type, data) {
  state.events.push({
    seq: state.events.length,
    time: meta.time,
    source: meta.source || 'cli',
    caseId,
    type,
    data,
  });
  state.now = Math.max(state.now, meta.time);
  finalize(state);
}

function needCase(state, id) {
  const c = state.cases[id];
  if (!c) throw new AuditError('CASE_UNKNOWN', `unknown case ${id}`, 1);
  return c;
}

function addReviewer(state, meta, { id, skills, unavailable = [] }) {
  if (state.reviewers[id]) throw new AuditError('DUPLICATE_REVIEWER', `reviewer ${id} already exists`, 1);
  const entry = { skills: [...skills].sort(), unavailable };
  state.reviewers[id] = entry;
  record(state, meta, id, 'reviewer_open', entry);
  return entry;
}

function openCase(state, meta, { id, dept, risk, deadline, duration, skill }) {
  if (state.cases[id]) throw new AuditError('DUPLICATE_CASE', `case ${id} already exists`, 1);
  if (deadline <= meta.time) {
    throw new AuditError('DEADLINE_PAST', `statutory deadline ${deadline} is not after now ${meta.time}`);
  }
  const skilled = Object.values(state.reviewers).some((r) => r.skills.includes(skill));
  if (!skilled) throw new AuditError('SKILL_MISMATCH', `no reviewer holds skill ${skill}`);
  const c = {
    id, dept, risk, deadline, duration, skill,
    openedAt: meta.time,
    status: 'open',
    credits: 0,
    assignment: null,
    conclusion: null,
    appeal: null,
    history: [],
  };
  state.cases[id] = c;
  record(state, meta, id, 'case_open', { dept, risk, deadline, duration, skill });
  return c;
}

function correctRisk(state, meta, { id, risk }) {
  const c = needCase(state, id);
  if (c.status === 'concluded') throw new AuditError('CASE_CLOSED', `case ${id} is concluded; risk is locked`, 1);
  if (c.status === 'appeal_open') throw new AuditError('CASE_FROZEN', `case ${id} is frozen by an open appeal`, 1);
  const from = c.risk;
  c.risk = risk;
  record(state, meta, id, 'risk_correct', { from, to: risk });
  return { from, to: risk };
}

function runAssign(state, meta) {
  const now = meta.time;
  const prevAssignment = {};
  for (const c of Object.values(state.cases)) {
    if (c.assignment) prevAssignment[c.id] = { ...c.assignment };
  }
  const { assignments, rejections } = plan(state, now);
  const byId = Object.fromEntries(assignments.map((a) => [a.caseId, a]));
  const preemptions = [];

  for (const c of Object.values(state.cases)) {
    if (byId[c.id]) {
      const a = byId[c.id];
      c.assignment = { reviewer: a.reviewer, start: a.start, end: a.end };
      c.status = 'assigned';
    } else if (rejections[c.id]) {
      const wasUnstarted = prevAssignment[c.id] && prevAssignment[c.id].start >= now;
      const stillFeasible = c.deadline - c.duration >= now;
      if (wasUnstarted && stillFeasible) {
        // A higher-risk case took this case's not-yet-started slot: compensate.
        c.credits += state.config.preemptCredit;
        c.status = 'preempted';
        c.assignment = null;
        preemptions.push({ caseId: c.id, credit: state.config.preemptCredit, reason: 'displaced_by_higher_risk' });
      } else if (c.status !== 'concluded' && c.status !== 'appeal_open') {
        c.assignment = null;
        if (c.status === 'assigned') c.status = 'open';
      }
    }
  }

  const result = { assignments, rejections, preemptions };
  record(state, meta, '*', 'assign', result);
  return result;
}

function signConclusion(state, meta, id) {
  const c = needCase(state, id);
  if (c.appeal && c.appeal.status === 'open') {
    throw new AuditError('APPEAL_PENDING', `case ${id} has an open appeal; close it with a decision`, 1);
  }
  if (c.status === 'concluded') throw new AuditError('ALREADY_CONCLUDED', `case ${id} already concluded`, 1);
  if (!c.assignment) throw new AuditError('NOT_ASSIGNED', `case ${id} has no assignment`, 1);
  if (meta.time < c.assignment.end) {
    throw new AuditError('WORK_NOT_FINISHED', `case ${id} finishes at ${c.assignment.end}`, 1);
  }
  const conclusion = {
    signedAt: meta.time,
    reviewer: c.assignment.reviewer,
    start: c.assignment.start,
    end: c.assignment.end,
    risk: c.risk,
    frozen: false,
  };
  conclusion.hash = crypto.createHash('sha256').update(canonical({ caseId: id, ...conclusion })).digest('hex');
  c.conclusion = conclusion;
  c.status = 'concluded';
  record(state, meta, id, 'conclude', conclusion);
  return conclusion;
}

function openAppeal(state, meta, { id, level = 1 }) {
  const c = needCase(state, id);
  if (c.appeal && c.appeal.status === 'open') {
    throw new AuditError('DUPLICATE_APPEAL', `case ${id} already has an open appeal`);
  }
  if (!c.conclusion) throw new AuditError('NO_CONCLUSION', `case ${id} has no conclusion to appeal`, 1);
  c.appeal = { level, openedAt: meta.time, status: 'open' };
  c.conclusion.frozen = true; // frozen, not deleted
  c.status = 'appeal_open';
  record(state, meta, id, 'appeal_open', { level });
  return c.appeal;
}

function closeCase(state, meta, { id, decision }) {
  const c = needCase(state, id);
  if (c.appeal && c.appeal.status === 'open') {
    if (!decision) throw new AuditError('DECISION_REQUIRED', `case ${id} appeal needs --decision uphold|overturn`, 1);
    const level = c.appeal.level;
    if (decision === 'uphold') {
      c.appeal.status = 'confirmed';
      c.appeal.resolvedAt = meta.time;
      c.conclusion.frozen = false;
      c.status = 'concluded';
    } else if (decision === 'overturn') {
      c.appeal.status = 'rolled_back';
      c.appeal.resolvedAt = meta.time;
      c.history.push({ type: 'revoked_conclusion', conclusion: c.conclusion, at: meta.time });
      c.conclusion = null;
      c.assignment = null;
      c.status = 'open';
    } else {
      throw new AuditError('BAD_DECISION', 'decision must be uphold|overturn', 1);
    }
    record(state, meta, id, 'appeal_close', { decision, level });
    return { appeal: c.appeal };
  }
  if (decision) throw new AuditError('NO_OPEN_APPEAL', `case ${id} has no open appeal`, 1);
  return { conclusion: signConclusion(state, meta, id) };
}

function snapshotState(state) {
  finalize(state);
  return { certificate: state.certificate, eventCount: state.events.length, state };
}

module.exports = {
  GENESIS,
  AuditError,
  DEFAULT_CONFIG,
  createState,
  canonical,
  recomputeCertificate,
  finalize,
  addReviewer,
  openCase,
  correctRisk,
  runAssign,
  openAppeal,
  closeCase,
  snapshotState,
};
