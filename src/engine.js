'use strict';

const crypto = require('crypto');
const { schedule, DEFAULTS } = require('./schedule');

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const EXIT8_CODES = new Set(['SKILL_MISMATCH', 'DEADLINE_PAST', 'DUPLICATE_APPEAL']);
const GENESIS = '0'.repeat(64);

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function hashHex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function createState() {
  return { certHash: GENESIS, eventCount: 0, cases: {}, assignments: {}, certificates: [] };
}

function getCase(state, caseId) {
  const c = state.cases[caseId];
  if (!c) throw new DomainError('UNKNOWN_CASE', `unknown case: ${caseId}`);
  return c;
}

function openCase(state, reviewers, p) {
  if (state.cases[p.caseId]) {
    throw new DomainError('DUPLICATE_CASE', `case already open: ${p.caseId}`);
  }
  if (!(p.deadline > p.time)) {
    throw new DomainError(
      'DEADLINE_PAST',
      `statutory deadline ${p.deadline} is not after logical time ${p.time}`
    );
  }
  if (!reviewers.some((r) => (r.skills || []).includes(p.skill))) {
    throw new DomainError('SKILL_MISMATCH', `no reviewer holds required skill: ${p.skill}`);
  }
  return {
    type: 'OPEN',
    time: p.time,
    source: p.source || 'cli',
    caseId: p.caseId,
    dept: p.dept,
    risk: p.risk,
    deadline: p.deadline,
    skill: p.skill,
    duration: p.duration,
  };
}

function correctRisk(state, p) {
  const c = getCase(state, p.caseId);
  if (c.status === 'concluded') {
    throw new DomainError(
      'CASE_CLOSED',
      `case ${p.caseId} is concluded; signed conclusions are immutable`
    );
  }
  return { type: 'CORRECT', time: p.time, source: p.source || 'cli', caseId: p.caseId, risk: p.risk };
}

function openAppeal(state, p) {
  const c = getCase(state, p.caseId);
  if (!c.conclusion || c.conclusion.status === 'revoked') {
    throw new DomainError('NO_CONCLUSION', `case ${p.caseId} has no active conclusion to appeal`);
  }
  if (c.appeal) {
    throw new DomainError('DUPLICATE_APPEAL', `case ${p.caseId} already has an open appeal`);
  }
  return {
    type: 'APPEAL_OPEN',
    time: p.time,
    source: p.source || 'cli',
    caseId: p.caseId,
    level: p.level ?? 1,
  };
}

function closeAppeal(state, p) {
  const c = getCase(state, p.caseId);
  if (!c.appeal) {
    throw new DomainError('NO_APPEAL', `no open appeal for case ${p.caseId}`);
  }
  const decision = c.appeal.level >= c.conclusion.level ? 'revoked' : 'confirmed';
  return {
    type: 'APPEAL_CLOSE',
    time: p.time,
    source: p.source || 'cli',
    caseId: p.caseId,
    decision,
  };
}

function closeCase(state, p) {
  const c = getCase(state, p.caseId);
  if (c.status === 'concluded') {
    throw new DomainError('CASE_CLOSED', `case ${p.caseId} is already concluded`);
  }
  if (c.status !== 'assigned') {
    throw new DomainError('NOT_ASSIGNED', `case ${p.caseId} has no active review assignment`);
  }
  return {
    type: 'CASE_CLOSE',
    time: p.time,
    source: p.source || 'cli',
    caseId: p.caseId,
    result: p.result || 'reviewed',
    level: p.level ?? 1,
  };
}

function planAssignments(state, reviewers, config, p) {
  const cfg = { ...DEFAULTS, ...config };
  const eligible = [];
  const prevNotStarted = new Map();
  for (const c of Object.values(state.cases)) {
    if (c.status === 'waiting') {
      eligible.push(c);
    } else if (c.status === 'assigned') {
      const a = state.assignments[c.id];
      if (a && a.start > p.time) {
        eligible.push(c);
        prevNotStarted.set(c.id, a);
      }
    }
  }
  const fixed = [];
  for (const [cid, a] of Object.entries(state.assignments)) {
    const c = state.cases[cid];
    if (c && c.status === 'assigned' && a.start <= p.time) {
      fixed.push({ ...a, caseId: cid, dept: c.dept });
    }
  }
  const result = schedule(eligible, reviewers, p.time, cfg, fixed);

  const assignedNow = new Set(result.assignments.map((a) => a.caseId));
  const byId = new Map(eligible.map((c) => [c.id, c]));
  const alreadyPreempted = new Set(result.preemptions.map((x) => x.preempted));
  for (const cid of prevNotStarted.keys()) {
    if (assignedNow.has(cid) || alreadyPreempted.has(cid)) continue;
    const victim = byId.get(cid);
    const usurper = result.assignments
      .map((a) => byId.get(a.caseId))
      .filter(Boolean)
      .sort((a, b) => b.risk - a.risk || (a.id < b.id ? -1 : 1))
      .find((c) => c.risk > victim.risk);
    if (usurper) {
      result.preemptions.push({ preempted: cid, by: usurper.id, reason: 'replan' });
      result.compensations.push({ caseId: cid, credit: cfg.compensationCredit });
      const rej = result.rejections.find((r) => r.caseId === cid);
      if (rej) rej.code = 'PREEMPTED';
    }
  }

  const body = {
    kind: 'assignment-certificate',
    time: p.time,
    source: p.source || 'cli',
    method: result.method,
    assignments: [...result.assignments].sort((a, b) => (a.caseId < b.caseId ? -1 : 1)),
    rejections: [...result.rejections].sort((a, b) => (a.caseId < b.caseId ? -1 : 1)),
    preemptions: result.preemptions,
    compensations: result.compensations,
    prevHash: state.certHash,
  };
  const certificate = { ...body, hash: hashHex(canonical(body)) };
  return {
    event: { type: 'ASSIGN', time: p.time, source: p.source || 'cli', caseId: '', certificate },
    certificate,
  };
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'OPEN':
      state.cases[event.caseId] = {
        id: event.caseId,
        dept: event.dept,
        risk: event.risk,
        deadline: event.deadline,
        skill: event.skill,
        duration: event.duration,
        openedAt: event.time,
        credit: 0,
        status: 'waiting',
        conclusion: null,
        appeal: null,
      };
      break;
    case 'CORRECT':
      getCase(state, event.caseId).risk = event.risk;
      break;
    case 'APPEAL_OPEN': {
      const c = getCase(state, event.caseId);
      c.appeal = { level: event.level, openedAt: event.time };
      if (c.conclusion) c.conclusion.status = 'frozen';
      break;
    }
    case 'APPEAL_CLOSE': {
      const c = getCase(state, event.caseId);
      if (c.conclusion) c.conclusion.status = event.decision;
      if (event.decision === 'revoked') c.status = 'waiting';
      c.appeal = null;
      break;
    }
    case 'CASE_CLOSE': {
      const c = getCase(state, event.caseId);
      c.conclusion = {
        result: event.result,
        level: event.level,
        signedAt: event.time,
        status: 'signed',
      };
      c.status = 'concluded';
      delete state.assignments[event.caseId];
      break;
    }
    case 'ASSIGN': {
      const cert = event.certificate;
      for (const a of cert.assignments) {
        const c = state.cases[a.caseId];
        if (!c) continue;
        c.status = 'assigned';
        state.assignments[a.caseId] = { reviewerId: a.reviewerId, start: a.start, end: a.end };
      }
      for (const r of cert.rejections) {
        const c = state.cases[r.caseId];
        if (!c) continue;
        if (c.status === 'assigned') {
          c.status = 'waiting';
          delete state.assignments[r.caseId];
        }
      }
      for (const comp of cert.compensations) {
        const c = state.cases[comp.caseId];
        if (c) c.credit += comp.credit;
      }
      state.certificates.push({ time: event.time, hash: cert.hash });
      break;
    }
    default:
      throw new DomainError('UNKNOWN_EVENT', `unknown event type: ${event.type}`);
  }
  state.certHash = hashHex(state.certHash + '|' + canonical(event));
  state.eventCount += 1;
  return state;
}

module.exports = {
  DomainError,
  EXIT8_CODES,
  GENESIS,
  canonical,
  hashHex,
  createState,
  applyEvent,
  openCase,
  correctRisk,
  openAppeal,
  closeAppeal,
  closeCase,
  planAssignments,
};
