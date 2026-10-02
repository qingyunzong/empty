import { evaluateClaim } from './verify.js';
import { hashValue } from './canonical.js';
import { EvpackError, E_UNDECIDED, E_CERT_MISMATCH, E_INVALID } from './errors.js';

export const CERT_FORMAT = 'evpack-cert/1';

// Issue a reviewable certificate for a claim. Undecided conclusions cannot
// be certified: the unknowns must be resolved (asserted or ruled out) first.
export function issueCert(store, claim, now = new Date().toISOString()) {
  const r = evaluateClaim(store, claim);
  if (r.conclusion === 'undecided') {
    throw new EvpackError(
      E_UNDECIDED,
      `claim is undecided; unresolved evidence: ${[...r.undecided, ...r.retracted].join(', ') || '(none)'}`
    );
  }
  const body = {
    format: CERT_FORMAT,
    claim,
    claimHash: hashValue(claim),
    inputHash: r.inputHash,
    ruleVersion: r.ruleVersion,
    conclusion: r.conclusion,
    hitEvidenceKeys: r.hits,
    undecided: r.undecided,
    retracted: r.retracted,
    bestRules: r.bestRules,
    issuedAt: now,
  };
  return { ...body, hash: hashValue(body) };
}

const sameKeys = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
  [...a].sort().every((k, i) => k === [...b].sort()[i]);

// Verify a certificate against the current store. Any tampering with the
// cert body, or any drift of the underlying inputs since issuance, raises
// E_CERT_MISMATCH.
export function checkCert(store, cert) {
  if (!cert || typeof cert !== 'object' || cert.format !== CERT_FORMAT) {
    throw new EvpackError(E_INVALID, 'not an evpack certificate');
  }
  const { hash, ...body } = cert;
  if (typeof hash !== 'string' || hashValue(body) !== hash) {
    throw new EvpackError(E_CERT_MISMATCH, 'certificate body hash mismatch (tampered)');
  }
  if (body.inputHash !== store.inputHash()) {
    throw new EvpackError(E_CERT_MISMATCH, 'input hash mismatch (pack changed since issuance)');
  }
  if (body.ruleVersion !== store.ruleVersion) {
    throw new EvpackError(E_CERT_MISMATCH, 'rule version mismatch');
  }
  const r = evaluateClaim(store, body.claim);
  if (r.conclusion !== body.conclusion) {
    throw new EvpackError(E_CERT_MISMATCH, `conclusion mismatch: cert=${body.conclusion} actual=${r.conclusion}`);
  }
  if (!sameKeys(r.hits, body.hitEvidenceKeys)) {
    throw new EvpackError(E_CERT_MISMATCH, 'hit evidence keys mismatch');
  }
  return { ok: true, claimHash: body.claimHash, conclusion: body.conclusion };
}
