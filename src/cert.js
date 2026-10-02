import { canonical, hashValue } from './canonical.js';
import { E, EvpackError } from './errors.js';
import { canonicalClaim } from './store.js';

export const CERT_FORMAT = 'evpack-cert/1';

// A certificate binds a claim evaluation to the exact input state: input
// hash, rule-set version, the evidence keys that drove the conclusion, and
// the explicit undecided (pending) items.
export function issueCert(engine, claim) {
  const result = engine.evaluate(claim);
  const body = {
    format: CERT_FORMAT,
    claim: canonicalClaim(claim),
    conclusion: result.conclusion,
    aggregate: result.aggregate,
    hitEvidenceKeys: result.hitEvidenceKeys,
    undecided: result.undecided,
    appliedRules: result.appliedRules,
    excludedByRule: result.excludedByRule,
    inputHash: engine.store.inputHash(),
    rulesVersion: engine.store.rulesVersion(),
  };
  return { ...body, certHash: hashValue(body) };
}

function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}

export function verifyCert(engine, cert) {
  if (!cert || cert.format !== CERT_FORMAT || typeof cert.certHash !== 'string') {
    throw new EvpackError(E.CERT_MISMATCH, 'malformed certificate');
  }
  const { certHash, ...body } = cert;
  if (hashValue(body) !== certHash) {
    throw new EvpackError(E.CERT_MISMATCH, 'certificate content hash mismatch (tampered)');
  }
  if (body.inputHash !== engine.store.inputHash()) {
    throw new EvpackError(E.CERT_MISMATCH, 'input hash mismatch: evidence base changed');
  }
  if (body.rulesVersion !== engine.store.rulesVersion()) {
    throw new EvpackError(E.CERT_MISMATCH, 'rule version mismatch');
  }
  const result = engine.evaluate(body.claim);
  const checks = ['conclusion', 'aggregate', 'hitEvidenceKeys', 'undecided', 'appliedRules', 'excludedByRule'];
  for (const field of checks) {
    if (!deepEqual(body[field], result[field])) {
      throw new EvpackError(E.CERT_MISMATCH, `certificate field mismatch: ${field}`);
    }
  }
  return true;
}
