'use strict';

const {
  ReconError,
  contentKey,
  chainsByAccount,
  balanceReport,
  isBalancedEvents,
  normalizeBook,
} = require('./model');
const { jointAcceptable } = require('./automaton');
const { minRepairScripts } = require('./repair');

function firstDivergence(source, otherById, otherName) {
  for (let i = 0; i < source.length; i += 1) {
    const e = source[i];
    const o = otherById.get(e.id);
    if (!o) return { cut: i, issue: { kind: `missing-in-${otherName}`, id: e.id } };
    if (contentKey(o) !== contentKey(e)) {
      return {
        cut: i,
        issue: { kind: 'content-mismatch', id: e.id, sourceEvent: e, otherEvent: o },
      };
    }
  }
  return { cut: source.length, issue: null };
}

// Certificate of non-acceptance: the prefixes of both books that lead the
// product automaton into a rejecting region, plus the optional continuation
// (the remaining suffix of each book). Deterministic given the two books.
function buildRejectCertificate(L, R) {
  const byIdL = new Map(L.map((e) => [e.id, e]));
  const byIdR = new Map(R.map((e) => [e.id, e]));
  const left = firstDivergence(L, byIdR, 'right');
  const right = firstDivergence(R, byIdL, 'left');
  if (left.issue || right.issue) {
    return {
      type: 'reject',
      reason: 'content-divergence',
      leftPrefix: L.slice(0, left.cut).map((e) => e.id),
      rightPrefix: R.slice(0, right.cut).map((e) => e.id),
      leftContinuation: L.slice(left.cut).map((e) => e.id),
      rightContinuation: R.slice(right.cut).map((e) => e.id),
      details: { left: left.issue, right: right.issue },
    };
  }
  const chainsL = chainsByAccount(L);
  const chainsR = chainsByAccount(R);
  const accounts = [...new Set([...chainsL.keys(), ...chainsR.keys()])].sort();
  for (const account of accounts) {
    const a = chainsL.get(account) || [];
    const b = chainsR.get(account) || [];
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      return {
        type: 'reject',
        reason: 'account-order',
        leftPrefix: L.map((e) => e.id),
        rightPrefix: R.map((e) => e.id),
        leftContinuation: [],
        rightContinuation: [],
        details: { account, leftChain: a, rightChain: b },
      };
    }
  }
  const offending = balanceReport(L)
    .filter((g) => !g.balanced)
    .map(({ rel, currency, sum, debits, credits }) => ({ rel, currency, sum, debits, credits }));
  return {
    type: 'reject',
    reason: 'unbalanced',
    leftPrefix: L.map((e) => e.id),
    rightPrefix: R.map((e) => e.id),
    leftContinuation: [],
    rightContinuation: [],
    details: { groups: offending },
  };
}

function invalid(message) {
  throw new ReconError('CERT_INVALID', message);
}

function verifyAccept(L, R, cert) {
  if (!Array.isArray(cert.witness)) invalid('accept certificate needs a witness sequence');
  if (!jointAcceptable(L, R)) invalid('books are not jointly acceptable');
  const byIdL = new Map(L.map((e) => [e.id, e]));
  const byIdR = new Map(R.map((e) => [e.id, e]));
  if (cert.witness.length !== L.length) invalid('witness length mismatch');
  const seen = new Set();
  for (const id of cert.witness) {
    if (!byIdL.has(id) || !byIdR.has(id) || seen.has(id)) {
      invalid(`witness event "${id}" is not a common event`);
    }
    seen.add(id);
  }
  const restrict = (ids, account, byId) => ids.filter((id) => byId.get(id).account === account);
  for (const [account, ids] of chainsByAccount(L)) {
    if (JSON.stringify(restrict(cert.witness, account, byIdL)) !== JSON.stringify(ids)) {
      invalid(`witness violates left causal order on account ${account}`);
    }
  }
  for (const [account, ids] of chainsByAccount(R)) {
    if (JSON.stringify(restrict(cert.witness, account, byIdR)) !== JSON.stringify(ids)) {
      invalid(`witness violates right causal order on account ${account}`);
    }
  }
  if (!isBalancedEvents(L)) invalid('accept certificate but books are unbalanced');
  return true;
}

function verifyReject(L, R, cert) {
  const expect = buildRejectCertificate(L, R);
  const fields = ['reason', 'leftPrefix', 'rightPrefix', 'leftContinuation', 'rightContinuation', 'details'];
  for (const field of fields) {
    if (JSON.stringify(cert[field]) !== JSON.stringify(expect[field])) {
      invalid(`reject certificate field "${field}" does not match the books`);
    }
  }
  if (cert.repair && typeof cert.repair.minCost === 'number') {
    const res = minRepairScripts(L, R, cert.repair.minCost);
    if (res.status !== 'found' || res.cost !== cert.repair.minCost) {
      invalid('claimed repair minCost does not hold');
    }
  }
  return true;
}

// Verify a certificate against the two books. Throws ReconError with code
// CERT_INVALID on any mismatch; returns true when the certificate is valid.
function verifyCertificate(leftEvents, rightEvents, cert) {
  const L = normalizeBook(leftEvents, 'left');
  const R = normalizeBook(rightEvents, 'right');
  if (!cert || typeof cert !== 'object' || Array.isArray(cert)) {
    invalid('certificate must be an object');
  }
  if (cert.type === 'accept') return verifyAccept(L, R, cert);
  if (cert.type === 'reject') return verifyReject(L, R, cert);
  if (cert.type === 'search-bound') {
    if (jointAcceptable(L, R)) invalid('books are jointly acceptable');
    if (!Number.isInteger(cert.k) || cert.k < 0) invalid('bad search bound k');
    const res = minRepairScripts(L, R, cert.k);
    if (res.status === 'found') invalid('a repair script within the bound exists');
    if (res.provenLowerBound !== cert.provenLowerBound) {
      invalid('provenLowerBound does not hold');
    }
    if (!cert.reject || cert.reject.type !== 'reject') invalid('missing nested reject certificate');
    return verifyReject(L, R, cert.reject);
  }
  invalid(`unknown certificate type "${cert.type}"`);
  return false;
}

module.exports = { buildRejectCertificate, verifyCertificate };
