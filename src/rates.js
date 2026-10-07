'use strict';

const { CODES, ReconError } = require('./errors');
const { parseUtcInstant } = require('./tztable');

// A rate interval: { id, pair, rate, startUtc, endUtc, version }.
// Half-open over UTC: [startUtc, endUtc).
function normalizeRates(raw) {
  if (!Array.isArray(raw)) {
    throw new ReconError(CODES.TZVER, 'rates must be an array');
  }
  return raw.map((r, i) => {
    for (const field of ['id', 'pair', 'version']) {
      if (typeof r[field] !== 'string' || r[field].length === 0) {
        throw new ReconError(CODES.TZVER, `rates[${i}]: "${field}" must be a non-empty string`);
      }
    }
    if (typeof r.rate !== 'number' || !(r.rate > 0)) {
      throw new ReconError(CODES.TZVER, `rates[${i}]: "rate" must be a positive number`);
    }
    const startUtc = parseUtcInstant(r.startUtc);
    const endUtc = parseUtcInstant(r.endUtc);
    if (!(startUtc < endUtc)) {
      throw new ReconError(CODES.TZVER, `rates[${i}]: startUtc must be < endUtc`);
    }
    return { id: r.id, pair: r.pair, rate: r.rate, version: r.version, startUtc, endUtc };
  });
}

function findRate(rates, pair, utcEpoch) {
  if (utcEpoch === null || utcEpoch === undefined) return null;
  return rates.find((r) => r.pair === pair && utcEpoch >= r.startUtc && utcEpoch < r.endUtc) || null;
}

// Intervals of `pair` that intersect the half-open window [startEpoch, endEpoch).
function intersectingRates(rates, pair, startEpoch, endEpoch) {
  return rates.filter(
    (r) => r.pair === pair && r.startUtc < endEpoch && startEpoch < r.endUtc
  );
}

module.exports = { normalizeRates, findRate, intersectingRates };
