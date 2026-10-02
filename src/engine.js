'use strict';

const { AuditError } = require('./errors');
const { resolveLedger } = require('./ledger');
const { validateStrata, checkQuotas } = require('./sampler');
const { buildStratumCertificate, composeCertificate, populationHash } = require('./certificate');

const EMPTY_STATE = { seed: null, lastVersion: null, strata: {}, history: [] };

function normalizeState(state) {
  if (!state || typeof state !== 'object') return { ...EMPTY_STATE, strata: {}, history: [] };
  return {
    seed: typeof state.seed === 'string' ? state.seed : null,
    lastVersion: Number.isInteger(state.lastVersion) ? state.lastVersion : null,
    strata: state.strata && typeof state.strata === 'object' ? state.strata : {},
    history: Array.isArray(state.history) ? state.history : [],
  };
}

function invalidateEntry(cert, reason) {
  return {
    stratum: cert.stratum,
    supersededVersion: cert.sampledAtVersion,
    stratumRoot: cert.stratumRoot,
    populationHash: cert.populationHash,
    reason,
  };
}

// Run one sampling request against optional prior state (incremental mode).
// Returns { output, state } where state is the full updated store snapshot.
function runSample(request, priorState) {
  if (!request || typeof request !== 'object') {
    throw new AuditError('INVALID_INPUT', 'request must be a JSON object');
  }
  if (typeof request.seed !== 'string' || request.seed.length === 0) {
    throw new AuditError('SEED_REQUIRED', 'request.seed must be a non-empty string');
  }
  const seed = request.seed;
  if (!Number.isInteger(request.version) || request.version < 0) {
    throw new AuditError('INVALID_INPUT', 'request.version must be a non-negative integer');
  }
  const version = request.version;

  const { populations } = resolveLedger(request.ledger || [], request.revocations || []);
  validateStrata(request.strata, populations);
  const hashEvaluations = checkQuotas(request.strata, populations, request.computeBudget);

  const state = normalizeState(priorState);
  const seedChanged = state.seed !== null && state.seed !== seed;
  const nextStrata = {};
  const invalidated = [];
  const history = state.history.slice();

  const strataDefs = request.strata.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const certs = [];

  for (const def of strataDefs) {
    const population = populations.get(def.id);
    const popHash = populationHash(population);
    const existing = seedChanged ? null : state.strata[def.id];

    if (existing
        && existing.status === 'ACTIVE'
        && existing.populationHash === popHash
        && existing.quota === def.quota) {
      // Unaffected stratum: reuse the existing certificate untouched.
      nextStrata[def.id] = existing;
      certs.push(existing);
      continue;
    }

    if (existing && existing.status === 'ACTIVE') {
      const reason = seedChanged
        ? 'SEED_CHANGED'
        : existing.quota !== def.quota
          ? 'QUOTA_CHANGED'
          : 'POPULATION_CHANGED';
      const entry = invalidateEntry(existing, reason);
      invalidated.push(entry);
      history.push({ ...entry, status: 'SUPERSEDED', supersededAtVersion: version });
    } else if (seedChanged && state.strata[def.id] && state.strata[def.id].status === 'ACTIVE') {
      const entry = invalidateEntry(state.strata[def.id], 'SEED_CHANGED');
      invalidated.push(entry);
      history.push({ ...entry, status: 'SUPERSEDED', supersededAtVersion: version });
    }

    const cert = buildStratumCertificate(seed, def.id, def.quota, population, version);
    cert.status = 'ACTIVE';
    nextStrata[def.id] = cert;
    certs.push(cert);
  }

  // Strata that existed before but are gone from the request are caught by
  // validateStrata (STRATA_MISSING) before we get here, so no orphan handling
  // is required.

  const quotaUse = {
    perStratum: Object.fromEntries(strataDefs.map((def) => {
      const population = populations.get(def.id);
      return [def.id, { quota: def.quota, population: population.length, drawn: def.quota }];
    })),
    hashEvaluations,
    computeBudget: request.computeBudget ?? null,
  };

  const output = composeCertificate(seed, version, certs, invalidated, quotaUse);

  const nextState = {
    seed,
    lastVersion: state.lastVersion === null ? version : Math.max(state.lastVersion, version),
    strata: nextStrata,
    history,
  };

  return { output, state: nextState };
}

module.exports = { runSample, normalizeState, EMPTY_STATE };
