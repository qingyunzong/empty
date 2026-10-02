import { createHash } from 'node:crypto';
import { InputError } from './errors.js';
import { canonicalState } from './samples.js';

// Certificate chain (audit ledger). Every decision produces a certificate
// carrying the rule hash, the sample-set hash and a version number. A sample
// correction creates a new version; the previous certificate is marked
// SUPERSEDED but is never deleted. Rollback may only discard uncommitted
// DRAFT certificates -- published decisions stay traceable forever.

export const GENESIS_HASH = '0'.repeat(64);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function hashRule(sourceText) {
  return sha256(sourceText);
}

export function hashSamples(state) {
  return sha256(JSON.stringify(canonicalState(state)));
}

function certHashOf({ version, decision, ruleHash, sampleHash, prevHash }) {
  return sha256(['qcert/1', version, decision, ruleHash, sampleHash, prevHash].join('\n'));
}

export function emptyChain(ruleHash, ruleName, ruleVersion) {
  return { format: 'qcert-chain/1', ruleHash, ruleName, ruleVersion, certs: [] };
}

export function appendCert(chain, { version, decision, sampleHash, status }) {
  const prev = chain.certs[chain.certs.length - 1];
  const cert = {
    version,
    decision,
    ruleHash: chain.ruleHash,
    sampleHash,
    prevHash: prev ? prev.certHash : GENESIS_HASH,
    status,
  };
  cert.certHash = certHashOf(cert);
  if (status === 'ACTIVE' && prev && prev.status === 'ACTIVE') {
    prev.status = 'SUPERSEDED';
  }
  chain.certs.push(cert);
  return cert;
}

export function lastPublishedVersion(chain) {
  let last = 0;
  for (const cert of chain.certs) {
    if (cert.status === 'ACTIVE' || cert.status === 'SUPERSEDED') last = cert.version;
  }
  return last;
}

// Rollback is only legal towards uncommitted drafts. Any attempt to roll
// back at or below a published (ACTIVE/SUPERSEDED) version is rejected.
export function rollback(chain, toVersion) {
  if (!Number.isInteger(toVersion) || toVersion < 0) {
    throw new InputError(`rollback target must be a non-negative integer, got '${toVersion}'`);
  }
  const published = lastPublishedVersion(chain);
  if (toVersion < published) {
    throw new InputError(
      `illegal rollback: cannot return to version ${toVersion}; ` +
      `version ${published} is a published decision and published decisions are immutable`,
    );
  }
  const kept = chain.certs.filter((cert) => cert.version <= toVersion);
  const dropped = chain.certs.length - kept.length;
  for (const cert of kept) {
    if (cert.status === 'DRAFT') {
      throw new InputError(
        `illegal rollback: version ${cert.version} is an uncommitted draft inside the kept range`,
      );
    }
  }
  chain.certs = kept;
  return dropped;
}

export function verifyChain(chain) {
  const results = [];
  const errors = [];
  let prevHash = GENESIS_HASH;
  let activeCount = 0;

  chain.certs.forEach((cert, idx) => {
    const problems = [];
    if (cert.ruleHash !== chain.ruleHash) problems.push('rule hash mismatch');
    if (cert.prevHash !== prevHash) problems.push('broken hash link');
    if (certHashOf(cert) !== cert.certHash) problems.push('certificate hash mismatch');
    if (!['ACTIVE', 'SUPERSEDED', 'DRAFT'].includes(cert.status)) {
      problems.push(`unknown status '${cert.status}'`);
    }
    if (cert.status === 'ACTIVE') activeCount += 1;
    if (idx > 0 && cert.version !== chain.certs[idx - 1].version + 1) {
      problems.push('version sequence gap');
    }
    prevHash = cert.certHash;
    results.push({
      version: cert.version,
      decision: cert.decision,
      status: cert.status,
      ok: problems.length === 0,
      problems,
    });
    for (const problem of problems) {
      errors.push(`v${cert.version}: ${problem}`);
    }
  });

  if (activeCount > 1) errors.push('more than one ACTIVE certificate');
  const published = chain.certs.filter((c) => c.status !== 'DRAFT');
  if (published.length > 0 && published[published.length - 1].status !== 'ACTIVE') {
    errors.push('latest published certificate is not ACTIVE');
  }
  const firstDraft = chain.certs.findIndex((c) => c.status === 'DRAFT');
  if (firstDraft !== -1 && chain.certs.slice(firstDraft).some((c) => c.status !== 'DRAFT')) {
    errors.push('published certificate found after a draft');
  }

  return { ok: errors.length === 0, results, errors };
}
