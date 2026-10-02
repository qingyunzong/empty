'use strict';

const { canon } = require('./canon');
const { sha256hex, merkleRoot, merkleProof, verifyMerkleProof } = require('./hash');

class AuditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function itemKey(entry) {
  if (entry.id !== undefined && entry.id !== null) return String(entry.id);
  return `${entry.source}#${entry.seq}`;
}

function requireFields(entry, stratum) {
  for (const field of ['source', 'seq', 'version']) {
    if (entry[field] === undefined || entry[field] === null) {
      throw new AuditError(
        'VERSION_CONFLICT',
        `entry in stratum "${stratum}" is missing required field "${field}"`,
        { stratum, entry },
      );
    }
  }
}

// Resolve concurrent ledger versions: entries are identified by (source, seq).
// The highest `version` wins; identical (version, source, seq) with differing
// payloads is a hard VERSION_CONFLICT. Revoked winners leave the population.
function resolvePopulation(entries, stratum) {
  const byKey = new Map();
  for (const entry of entries) {
    requireFields(entry, stratum);
    const key = `${entry.source}#${entry.seq}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, entry);
      continue;
    }
    if (entry.version > existing.version) {
      byKey.set(key, entry);
    } else if (entry.version === existing.version) {
      if (canon(entry) !== canon(existing)) {
        throw new AuditError(
          'VERSION_CONFLICT',
          `conflicting payloads for (version=${entry.version}, source=${entry.source}, seq=${entry.seq}) in stratum "${stratum}"`,
          { stratum, source: entry.source, seq: entry.seq, version: entry.version },
        );
      }
    }
    // older version: superseded, ignored
  }
  const items = [...byKey.values()].filter((e) => e.revoked !== true);
  items.sort((a, b) => {
    const ka = itemKey(a);
    const kb = itemKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return items;
}

// Deterministic, unbiased selection: rank every item by
// H(seed | stratum | itemKey) and keep the `quota` smallest ranks.
// Equivalent to a uniform random permutation, so every subset of size
// `quota` is equally likely; fully reproducible and verifiable.
function rankOf(seed, stratum, key) {
  return sha256hex(`${seed}|${stratum}|${key}`);
}

function selectSample(seed, stratum, items, quota) {
  if (!Number.isInteger(quota) || quota < 0) {
    throw new AuditError(
      'QUOTA',
      `quota for stratum "${stratum}" must be a non-negative integer, got ${JSON.stringify(quota)}`,
      { stratum, quota },
    );
  }
  if (quota > items.length) {
    throw new AuditError(
      'QUOTA',
      `quota ${quota} exceeds population ${items.length} in stratum "${stratum}"`,
      { stratum, quota, population: items.length },
    );
  }
  const ranked = items.map((item) => {
    const key = itemKey(item);
    return { key, rank: rankOf(seed, stratum, key) };
  });
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : 1));
  return ranked.slice(0, quota).map((r) => r.key).sort();
}

function populationHash(items) {
  return sha256hex(canon(items.map(itemKey)));
}

// A certificate commits to (stratum, quota, population, populationHash,
// sample). The ledger version is deliberately NOT part of the commitment:
// the population hash is the stronger binding, and excluding the version is
// what allows a certificate to stay VALID across version bumps whose
// population did not change (incremental resampling).
function certificateHash(cert) {
  return sha256hex(canon({
    stratum: cert.stratum,
    quota: cert.quota,
    population: cert.population,
    populationHash: cert.populationHash,
    sample: cert.sample,
  }));
}

function normalizeInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AuditError('SEED_REQUIRED', 'input must be a JSON object');
  }
  if (input.seed === undefined || input.seed === null || input.seed === '') {
    throw new AuditError('SEED_REQUIRED', 'a non-empty "seed" is required for deterministic sampling');
  }
  const seed = String(input.seed);
  const version = input.version === undefined ? null : input.version;
  const strata = input.strata === null || input.strata === undefined ? {} : input.strata;
  const quotas = input.quotas === null || input.quotas === undefined ? {} : input.quotas;
  if (typeof strata !== 'object' || Array.isArray(strata)) {
    throw new AuditError('STRATA_MISSING', '"strata" must be an object mapping stratum name to entries');
  }
  if (typeof quotas !== 'object' || Array.isArray(quotas)) {
    throw new AuditError('QUOTA', '"quotas" must be an object mapping stratum name to a non-negative integer');
  }
  return { seed, version, strata, quotas, prev: input.prev ?? null };
}

// Missing strata must never be silently treated as empty populations.
function assertStrataPresent(strata, quotas) {
  const missing = Object.keys(quotas).filter(
    (name) => !(name in strata) || !Array.isArray(strata[name]),
  );
  if (missing.length > 0) {
    throw new AuditError(
      'STRATA_MISSING',
      `quotas reference strata with no ledger data: ${missing.join(', ')}`,
      { missing },
    );
  }
}

function prevCertificateMap(prev) {
  const map = new Map();
  if (prev && Array.isArray(prev.certificates)) {
    for (const cert of prev.certificates) {
      if (cert && typeof cert.stratum === 'string' && cert.status !== 'SUPERSEDED') {
        map.set(cert.stratum, cert);
      }
    }
  }
  return map;
}

function plan(input) {
  const { seed, version, strata, quotas, prev } = normalizeInput(input);
  assertStrataPresent(strata, quotas);

  const prevCerts = prevCertificateMap(prev);
  const prevRoot = prev && typeof prev.merkleRoot === 'string' ? prev.merkleRoot : null;

  const certificates = [];
  const invalidated = [];
  const quotaUse = {};
  const samples = {};

  const stratumNames = Object.keys(quotas).sort();
  for (const name of stratumNames) {
    const quota = quotas[name];
    const items = resolvePopulation(strata[name], name);
    const popHash = populationHash(items);
    const prior = prevCerts.get(name);

    // A prior certificate stays VALID iff the population and quota are
    // unchanged; only genuinely affected strata are resampled.
    const reusable = prior !== undefined && prior.populationHash === popHash && prior.quota === quota;

    let cert;
    if (reusable) {
      cert = {
        stratum: name,
        quota,
        population: items.length,
        populationHash: popHash,
        sample: prior.sample.slice(),
        status: 'VALID',
        reused: true,
      };
    } else {
      const sample = selectSample(seed, name, items, quota);
      cert = {
        stratum: name,
        quota,
        population: items.length,
        populationHash: popHash,
        sample,
        status: 'VALID',
        reused: false,
      };
      if (prior !== undefined) {
        invalidated.push({
          stratum: name,
          status: 'SUPERSEDED',
          reason: prior.populationHash !== popHash ? 'POPULATION_CHANGED' : 'QUOTA_CHANGED',
          supersededCertificate: { ...prior, status: 'SUPERSEDED' },
          supersededCertificateHash: certificateHash(prior),
          supersededBy: null, // filled after cert hashes are known
          previousMerkleRoot: prevRoot,
        });
      }
    }
    certificates.push(cert);
    samples[name] = cert.sample.slice();
    quotaUse[name] = { quota, used: cert.sample.length, population: items.length };
  }

  // Certificate hashes and the new merkle root.
  const certHashes = certificates.map(certificateHash);
  const root = merkleRoot(certHashes);
  const proofs = certificates.map((_, i) => merkleProof(certHashes, i));

  certificates.forEach((cert, i) => {
    cert.certificateHash = certHashes[i];
    cert.merkleProof = proofs[i];
  });

  for (const inv of invalidated) {
    const idx = certificates.findIndex((c) => c.stratum === inv.stratum);
    inv.supersededBy = certHashes[idx];
    // Proof that the old certificate existed under the previous root.
    if (prev && Array.isArray(prev.certificates)) {
      const prevHashes = prev.certificates.map(certificateHash);
      const prevIdx = prev.certificates.findIndex(
        (c) => c.stratum === inv.stratum && c.status !== 'SUPERSEDED',
      );
      if (prevIdx >= 0 && prevRoot && merkleRoot(prevHashes) === prevRoot) {
        inv.invalidationProof = merkleProof(prevHashes, prevIdx);
      }
    }
  }

  return {
    ok: true,
    seed,
    version,
    samples,
    certificates,
    merkleRoot: root,
    invalidated,
    quotaUse,
  };
}

// Recompute everything from scratch and confirm the reported result is
// exactly what the deterministic algorithm yields for (seed, version).
function verify(input, result) {
  const checks = [];
  const expected = plan({
    seed: result.seed,
    version: result.version,
    strata: input.strata,
    quotas: input.quotas ?? Object.fromEntries(
      result.certificates.map((c) => [c.stratum, c.quota]),
    ),
  });
  const rootOk = expected.merkleRoot === result.merkleRoot;
  checks.push({ check: 'merkleRoot', ok: rootOk });
  let samplesOk = true;
  for (const name of Object.keys(expected.samples)) {
    if (canon(expected.samples[name]) !== canon(result.samples[name])) samplesOk = false;
  }
  checks.push({ check: 'samples', ok: samplesOk });
  let proofsOk = true;
  for (const cert of result.certificates) {
    if (certificateHash(cert) !== cert.certificateHash) proofsOk = false;
    else if (!verifyMerkleProof(cert.certificateHash, cert.merkleProof, result.merkleRoot)) proofsOk = false;
  }
  checks.push({ check: 'certificateProofs', ok: proofsOk });
  return { ok: rootOk && samplesOk && proofsOk, checks };
}

module.exports = {
  plan,
  verify,
  AuditError,
  resolvePopulation,
  selectSample,
  certificateHash,
  populationHash,
  itemKey,
};
