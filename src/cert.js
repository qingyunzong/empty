import { CertError } from './errors.js';
import { hashObject } from './hash.js';

export const CERT_FORMAT = 'qcert/1';

// Issues a decision certificate binding rule hash, sample hash and versions.
export function issueCertificate({ ruleSource, program, sampleVersion, sampleHash, inputs, decision, now }) {
  const cert = {
    format: CERT_FORMAT,
    rule_name: program.meta.name,
    rule_version: program.meta.version,
    rule_hash: hashObject({ source: ruleSource }),
    sample_version: sampleVersion,
    sample_hash: sampleHash,
    batch: inputs.batch_id,
    decision,
    inputs: {
      batch_size: inputs.batch_size,
      sampled: inputs.sampled,
      defects: inputs.defects,
      worst: inputs.worst,
    },
    issued_at: now ?? new Date().toISOString(),
  };
  cert.cert_hash = hashObject(cert);
  return cert;
}

const DECISIONS = new Set(['ACCEPT', 'REJECT', 'CONTINUE']);

// Structural + integrity verification. Returns { ok, errors, certHash }.
export function verifyCertificate(cert) {
  const errors = [];
  if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) {
    return { ok: false, errors: ['certificate must be a JSON object'], certHash: null };
  }
  if (cert.format !== CERT_FORMAT) errors.push(`unsupported format '${cert.format}'`);
  for (const field of ['rule_name', 'rule_hash', 'sample_hash', 'decision', 'issued_at', 'cert_hash']) {
    if (typeof cert[field] !== 'string' || cert[field] === '') errors.push(`missing or invalid field '${field}'`);
  }
  for (const field of ['rule_version', 'sample_version']) {
    if (!Number.isInteger(cert[field]) || cert[field] < 1) errors.push(`missing or invalid field '${field}'`);
  }
  if (typeof cert.decision === 'string' && !DECISIONS.has(cert.decision)) {
    errors.push(`invalid decision '${cert.decision}'`);
  }
  if (typeof cert.rule_hash === 'string' && !cert.rule_hash.startsWith('sha256:')) errors.push('rule_hash is not a sha256 digest');
  if (typeof cert.sample_hash === 'string' && !cert.sample_hash.startsWith('sha256:')) errors.push('sample_hash is not a sha256 digest');
  if (errors.length > 0) return { ok: false, errors, certHash: null };
  const { cert_hash: claimed, ...body } = cert;
  const actual = hashObject(body);
  if (actual !== claimed) {
    errors.push(`integrity check failed: content hashes to ${actual}, certificate claims ${claimed}`);
    return { ok: false, errors, certHash: actual };
  }
  return { ok: true, errors: [], certHash: actual };
}

export function mustVerify(cert) {
  const result = verifyCertificate(cert);
  if (!result.ok) throw new CertError(result.errors.join('; '));
  return result;
}
