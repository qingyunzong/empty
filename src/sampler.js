'use strict';

const { AuditError } = require('./errors');
const { selectionKey } = require('./util');

// Deterministic stratified selection: key every record, sort ascending, take
// the first `quota`. Keys are uniform over the hash range, so every subset of
// size `quota` is equally likely (simple random sample without replacement),
// and the result is a pure function of (seed, stratum, population).
function selectSample(seed, stratum, population, quota) {
  const keyed = population.map((entry) => ({
    id: entry.id,
    contentHash: entry.contentHash,
    key: selectionKey(seed, stratum, entry.id),
  }));
  keyed.sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return keyed.slice(0, quota);
}

// Validate strata/quota request against resolved populations.
// Missing strata are never silently treated as empty populations.
function validateStrata(strataDefs, populations) {
  if (!Array.isArray(strataDefs) || strataDefs.length === 0) {
    throw new AuditError('STRATA_MISSING', 'request must declare at least one stratum with a quota', {
      gaps: ['<request has no strata>'],
    });
  }
  const gaps = [];
  const seen = new Set();
  for (const def of strataDefs) {
    if (def === null || typeof def !== 'object' || typeof def.id !== 'string' || def.id.length === 0) {
      throw new AuditError('INVALID_INPUT', 'each stratum must have a non-empty string id');
    }
    if (seen.has(def.id)) {
      throw new AuditError('INVALID_INPUT', 'duplicate stratum id "' + def.id + '"', { stratum: def.id });
    }
    seen.add(def.id);
    if (!Number.isInteger(def.quota) || def.quota < 0) {
      throw new AuditError('QUOTA', 'quota for stratum "' + def.id + '" must be a non-negative integer', {
        stratum: def.id,
        quota: def.quota,
      });
    }
    if (!populations.has(def.id)) {
      gaps.push(def.id + ' (quota declared but no records in ledger)');
    }
  }
  for (const stratumId of populations.keys()) {
    if (!seen.has(stratumId)) {
      gaps.push(stratumId + ' (records present in ledger but no quota declared)');
    }
  }
  if (gaps.length > 0) {
    throw new AuditError('STRATA_MISSING', 'strata coverage gap between request and ledger', { gaps });
  }
}

function checkQuotas(strataDefs, populations, computeBudget) {
  let hashEvaluations = 0;
  for (const def of strataDefs) {
    const population = populations.get(def.id);
    hashEvaluations += population.length;
    if (def.quota > population.length) {
      throw new AuditError('QUOTA',
        'quota ' + def.quota + ' exceeds population ' + population.length + ' in stratum "' + def.id + '"',
        { stratum: def.id, quota: def.quota, population: population.length });
    }
  }
  if (computeBudget !== undefined && computeBudget !== null) {
    if (!Number.isInteger(computeBudget) || computeBudget < 0) {
      throw new AuditError('QUOTA', 'computeBudget must be a non-negative integer', { computeBudget });
    }
    if (hashEvaluations > computeBudget) {
      throw new AuditError('QUOTA', 'compute budget exceeded', {
        hashEvaluations,
        computeBudget,
      });
    }
  }
  return hashEvaluations;
}

module.exports = { selectSample, validateStrata, checkQuotas };
