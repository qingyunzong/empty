'use strict';

const { sha256, hashObject, selectionKey } = require('./util');
const { merkleRoot } = require('./merkle');

function populationHash(population) {
  const entries = population
    .map((entry) => ({ id: entry.id, contentHash: entry.contentHash }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hashObject(entries);
}

function leafHash(stratum, sampledAtVersion, record) {
  return hashObject({
    stratum,
    sampledAtVersion,
    id: record.id,
    contentHash: record.contentHash,
    key: record.key,
  });
}

// Per-stratum certificate: self-contained proof of population and selection.
function buildStratumCertificate(seed, stratum, quota, population, sampledAtVersion) {
  const keyed = population.map((entry) => ({
    id: entry.id,
    contentHash: entry.contentHash,
    key: selectionKey(seed, stratum, entry.id),
  }));
  keyed.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const selected = keyed.slice(0, quota);
  const leaves = selected.map((record) => leafHash(stratum, sampledAtVersion, record));
  return {
    stratum,
    sampledAtVersion,
    quota,
    populationSize: population.length,
    populationHash: populationHash(population),
    population: population
      .map((entry) => ({ id: entry.id, contentHash: entry.contentHash }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    selected,
    stratumRoot: merkleRoot(leaves),
  };
}

function composeCertificate(seed, version, stratumCerts, invalidated, quotaUse) {
  const strataOrder = stratumCerts.map((cert) => cert.stratum).sort();
  const rootByStratum = new Map(stratumCerts.map((cert) => [cert.stratum, cert.stratumRoot]));
  const merkleRootValue = merkleRoot(strataOrder.map((id) => rootByStratum.get(id)));
  return {
    seed,
    version,
    samples: stratumCerts.map((cert) => ({
      stratum: cert.stratum,
      sampledAtVersion: cert.sampledAtVersion,
      quota: cert.quota,
      populationSize: cert.populationSize,
      populationHash: cert.populationHash,
      population: cert.population,
      records: cert.selected,
      stratumRoot: cert.stratumRoot,
    })),
    merkleRoot: merkleRootValue,
    invalidated,
    quotaUse,
  };
}

// Self-contained verification: recompute keys, selection, population hashes
// and the merkle root purely from the certificate contents and the seed.
function verifyCertificate(certificate) {
  const checks = [];
  const fail = (name, detail) => {
    checks.push({ name, ok: false, detail });
    return { valid: false, checks };
  };

  if (!certificate || typeof certificate !== 'object') {
    return fail('structure', 'certificate must be an object');
  }
  if (typeof certificate.seed !== 'string' || certificate.seed.length === 0) {
    return fail('seed', 'certificate has no seed');
  }
  if (!Array.isArray(certificate.samples)) {
    return fail('structure', 'certificate.samples must be an array');
  }

  const stratumRoots = new Map();
  for (const sample of certificate.samples) {
    const name = 'stratum:' + sample.stratum;
    const popEntries = sample.population
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (hashObject(popEntries) !== sample.populationHash) {
      return fail(name, 'populationHash mismatch');
    }
    if (popEntries.length !== sample.populationSize) {
      return fail(name, 'populationSize mismatch');
    }
    const keyed = popEntries.map((entry) => ({
      id: entry.id,
      contentHash: entry.contentHash,
      key: selectionKey(certificate.seed, sample.stratum, entry.id),
    }));
    keyed.sort((a, b) => {
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const expected = keyed.slice(0, sample.quota);
    const actual = sample.records;
    if (actual.length !== expected.length) {
      return fail(name, 'selected record count mismatch');
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (actual[i].id !== expected[i].id || actual[i].key !== expected[i].key
          || actual[i].contentHash !== expected[i].contentHash) {
        return fail(name, 'selected record mismatch at position ' + i);
      }
    }
    const leaves = actual.map((record) => leafHash(sample.stratum, sample.sampledAtVersion, record));
    if (merkleRoot(leaves) !== sample.stratumRoot) {
      return fail(name, 'stratumRoot mismatch');
    }
    stratumRoots.set(sample.stratum, sample.stratumRoot);
    checks.push({ name, ok: true });
  }

  const strataOrder = Array.from(stratumRoots.keys()).sort();
  const recomposed = merkleRoot(strataOrder.map((id) => stratumRoots.get(id)));
  if (recomposed !== certificate.merkleRoot) {
    return fail('merkleRoot', 'certificate merkleRoot mismatch');
  }
  checks.push({ name: 'merkleRoot', ok: true });
  return { valid: true, checks };
}

module.exports = {
  buildStratumCertificate,
  composeCertificate,
  verifyCertificate,
  populationHash,
  leafHash,
};
