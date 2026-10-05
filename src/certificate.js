// Verifiable difference certificates.
//
// A certificate pinpoints a pair of stream prefixes (one per ledger) whose
// joint product-automaton state is provably rejecting: either the exposure
// multiset contains a canonical form that the remaining unread suffix of the
// opposite stream can never cancel, or a (relId, currency) group is closed
// (its relId never reappears) with a non-zero net. Anyone can re-run the
// automata over the prefixes and check the claim locally. When a repair
// script exists it is attached as the optional continuation; when the search
// bound was hit, the certificate carries the proven lower bound instead.

import { canonicalForm, groupNets } from './automaton.js';
import { multisetDiff, applyScript, isGoal, lowerBound } from './diff.js';
import { ReconError, ERR } from './errors.js';

export const CERT_TYPE = 'recon-diff-certificate';

function sortedObject(entries) {
  const obj = {};
  for (const [k, v] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) obj[k] = v;
  return obj;
}

function netsSummary(events) {
  const entries = [];
  for (const g of groupNets(events).values()) {
    if (g.net !== 0) entries.push([`${g.relId} ${g.currency}`, g.net]);
  }
  return sortedObject(entries);
}

function exposureOf(lp, rp) {
  const m = new Map();
  for (const e of lp) {
    const f = canonicalForm(e);
    m.set(f, (m.get(f) || 0) + 1);
  }
  for (const e of rp) {
    const f = canonicalForm(e);
    m.set(f, (m.get(f) || 0) - 1);
  }
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return m;
}

function productStateSummary(lp, rp) {
  return {
    leftNets: netsSummary(lp),
    rightNets: netsSummary(rp),
    exposure: sortedObject(exposureOf(lp, rp).entries()),
  };
}

export function buildCertificate(left, right, { reason, continuation = null, provenLowerBound = null, k = null }) {
  const { lOnly, rOnly } = multisetDiff(left, right);
  let li;
  let ri;
  if (lOnly.length > 0 || rOnly.length > 0) {
    // Shortest prefixes covering every unmatched event: any excess form in
    // the exposure at that point is doomed, because the opposite suffix
    // holds strictly fewer copies than the exposure demands.
    li = lOnly.length > 0 ? left.lastIndexOf(lOnly[lOnly.length - 1]) + 1 : left.length;
    ri = rOnly.length > 0 ? right.lastIndexOf(rOnly[rOnly.length - 1]) + 1 : right.length;
  } else {
    // Pure internal imbalance: full-stream prefixes close every group.
    li = left.length;
    ri = right.length;
  }
  const lp = left.slice(0, li);
  const rp = right.slice(0, ri);
  return {
    type: CERT_TYPE,
    version: 1,
    reason,
    leftPrefix: lp.map((e) => e.id),
    rightPrefix: rp.map((e) => e.id),
    productState: productStateSummary(lp, rp),
    continuation,
    provenLowerBound,
    k,
  };
}

function certInvalid(message) {
  return new ReconError(ERR.CERT_INVALID, `certificate invalid: ${message}`);
}

// Re-checks a certificate against the two ledgers. Returns { valid: true }
// or throws a ReconError with code CERT_INVALID.
export function verifyCertificate(left, right, cert) {
  if (!cert || typeof cert !== 'object') throw certInvalid('not an object');
  if (cert.type !== CERT_TYPE || cert.version !== 1) throw certInvalid('unknown type/version');
  if (!Array.isArray(cert.leftPrefix) || !Array.isArray(cert.rightPrefix)) throw certInvalid('prefixes must be arrays');
  const li = cert.leftPrefix.length;
  const ri = cert.rightPrefix.length;
  if (li > left.length || ri > right.length) throw certInvalid('prefix longer than stream');
  if (JSON.stringify(left.slice(0, li).map((e) => e.id)) !== JSON.stringify(cert.leftPrefix.map(String))) {
    throw certInvalid('leftPrefix is not a prefix of the left stream');
  }
  if (JSON.stringify(right.slice(0, ri).map((e) => e.id)) !== JSON.stringify(cert.rightPrefix.map(String))) {
    throw certInvalid('rightPrefix is not a prefix of the right stream');
  }
  const lp = left.slice(0, li);
  const rp = right.slice(0, ri);
  if (JSON.stringify(productStateSummary(lp, rp)) !== JSON.stringify(cert.productState)) {
    throw certInvalid('productState does not match a replay of the prefixes');
  }

  // Rejection proof: recompute why no completion of these prefixes can be
  // accepted by the product automaton.
  let proven = false;
  const exposure = exposureOf(lp, rp);
  for (const [form, count] of exposure) {
    if (count > 0) {
      const remaining = right.slice(ri).filter((e) => canonicalForm(e) === form).length;
      if (count > remaining) proven = true;
    } else {
      const remaining = left.slice(li).filter((e) => canonicalForm(e) === form).length;
      if (-count > remaining) proven = true;
    }
  }
  if (!proven) {
    for (const [prefix, suffix] of [[lp, left.slice(li)], [rp, right.slice(ri)]]) {
      const openRels = new Set(suffix.map((e) => e.relId));
      for (const g of groupNets(prefix).values()) {
        if (g.net !== 0 && !openRels.has(g.relId)) proven = true;
      }
    }
  }
  if (!proven) throw certInvalid('prefixes do not prove a rejecting product state');

  if (cert.continuation !== null && cert.continuation !== undefined) {
    if (!Array.isArray(cert.continuation)) throw certInvalid('continuation must be an array of ops');
    let repaired;
    try {
      repaired = applyScript(left, right, cert.continuation);
    } catch (e) {
      throw certInvalid(`continuation cannot be applied: ${e.message}`);
    }
    if (!isGoal(repaired.L, repaired.R)) throw certInvalid('continuation does not reach a jointly balanced state');
  }

  if (cert.provenLowerBound !== null && cert.provenLowerBound !== undefined) {
    if (!Number.isInteger(cert.provenLowerBound) || cert.provenLowerBound < 1) {
      throw certInvalid('provenLowerBound must be a positive integer');
    }
    const combinatorial = lowerBound(left, right);
    const searchClaim = cert.reason === 'SEARCH_BOUND' && Number.isInteger(cert.k)
      ? cert.k + 1
      : 0;
    if (cert.provenLowerBound > Math.max(combinatorial, searchClaim)) {
      throw certInvalid(`provenLowerBound ${cert.provenLowerBound} exceeds the verifiable lower bound`);
    }
  }
  return { valid: true };
}
