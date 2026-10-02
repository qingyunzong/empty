'use strict';

const { AuditError } = require('./errors');
const { canonical, hashObject } = require('./util');

function validateRecord(record, index) {
  const where = 'ledger[' + index + ']';
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new AuditError('INVALID_INPUT', where + ' must be an object');
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new AuditError('INVALID_INPUT', where + '.id must be a non-empty string');
  }
  if (typeof record.stratum !== 'string' || record.stratum.length === 0) {
    throw new AuditError('INVALID_INPUT', where + '.stratum must be a non-empty string', { id: record.id });
  }
  if (!Number.isInteger(record.version) || record.version < 0) {
    throw new AuditError('VERSION_CONFLICT', where + '.version must be a non-negative integer', { id: record.id });
  }
  if (typeof record.source !== 'string' || record.source.length === 0) {
    throw new AuditError('VERSION_CONFLICT', where + '.source must be a non-empty string', { id: record.id });
  }
  if (!Number.isInteger(record.seq) || record.seq < 0) {
    throw new AuditError('VERSION_CONFLICT', where + '.seq must be a non-negative integer', { id: record.id });
  }
}

// Total order over record metadata: (version, source, seq).
function compareMeta(a, b) {
  if (a.version !== b.version) return a.version - b.version;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.seq - b.seq;
}

// Resolve concurrent history: group records by id, keep the winner by
// (version, source, seq). Identical metadata with diverging payloads is a
// hard VERSION_CONFLICT. Revoked ids are excluded from the population.
function resolveLedger(ledger, revocations) {
  if (!Array.isArray(ledger)) {
    throw new AuditError('INVALID_INPUT', 'ledger must be an array of records');
  }
  ledger.forEach(validateRecord);

  const revoked = new Set(Array.isArray(revocations) ? revocations : []);
  const byId = new Map();
  for (const record of ledger) {
    if (!byId.has(record.id)) byId.set(record.id, []);
    byId.get(record.id).push(record);
  }

  const winners = [];
  for (const [id, versions] of byId) {
    const sorted = versions.slice().sort(compareMeta);
    const winner = sorted[sorted.length - 1];
    if (sorted.length > 1) {
      const runnerUp = sorted[sorted.length - 2];
      if (compareMeta(runnerUp, winner) === 0 && canonical(runnerUp) !== canonical(winner)) {
        throw new AuditError('VERSION_CONFLICT',
          'record "' + id + '" has diverging payloads at identical (version, source, seq)',
          {
            id,
            version: winner.version,
            source: winner.source,
            seq: winner.seq,
            payloads: [canonical(runnerUp), canonical(winner)],
          });
      }
    }
    if (!revoked.has(id)) winners.push(winner);
  }

  // Deterministic order independent of input ordering.
  winners.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const populations = new Map();
  for (const record of winners) {
    if (!populations.has(record.stratum)) populations.set(record.stratum, []);
    populations.get(record.stratum).push({
      id: record.id,
      contentHash: hashObject(record),
      record,
    });
  }
  return { populations, winners };
}

module.exports = { resolveLedger, compareMeta };
