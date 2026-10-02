import { toUnits, fmt, SCALE } from './decimal.js';
import { NettingError, ErrorCodes } from './errors.js';

// Versioned FX rate table. Each version carries a partial map of
// currency -> rate-to-base; effective rates merge all versions in order.
// Only the current (max) version may be used for settlement: requesting
// any other version fails with RATE_STALE.
export class RateTable {
  constructor({ base, versions }) {
    if (typeof base !== 'string' || base.length === 0) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, 'rates: "base" currency is required');
    }
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new NettingError(ErrorCodes.INPUT_INVALID, 'rates: "versions" must be a non-empty array');
    }
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    const seen = new Set();
    this.versions = sorted.map((v) => {
      if (!Number.isInteger(v.version) || v.version <= 0) {
        throw new NettingError(ErrorCodes.INPUT_INVALID, `rates: bad version number ${v.version}`);
      }
      if (seen.has(v.version)) {
        throw new NettingError(ErrorCodes.INPUT_INVALID, `rates: duplicate version ${v.version}`);
      }
      seen.add(v.version);
      const rates = new Map();
      for (const [ccy, r] of Object.entries(v.rates ?? {})) {
        const units = parseRate(r, ccy);
        rates.set(ccy, units);
      }
      return { version: v.version, rates };
    });
    this.base = base;
  }

  get currentVersion() {
    return this.versions[this.versions.length - 1].version;
  }

  effective(version) {
    if (version !== this.currentVersion) {
      throw new NettingError(
        ErrorCodes.RATE_STALE,
        `requested rates version ${version} is not current version ${this.currentVersion}`,
        { requested: version, current: this.currentVersion },
      );
    }
    const map = new Map([[this.base, SCALE]]);
    for (const v of this.versions) {
      for (const [ccy, r] of v.rates) map.set(ccy, r);
    }
    return map;
  }

  correct(currency, rate) {
    const units = parseRate(rate, currency);
    const version = this.currentVersion + 1;
    this.versions.push({ version, rates: new Map([[currency, units]]) });
    return version;
  }

  snapshot() {
    return {
      base: this.base,
      versions: this.versions.map((v) => ({
        version: v.version,
        rates: Object.fromEntries([...v.rates.entries()].map(([c, r]) => [c, fmt(r)])),
      })),
    };
  }
}

function parseRate(rate, ccy) {
  let units;
  try {
    units = toUnits(rate, `rate ${ccy}`);
  } catch (e) {
    throw new NettingError(ErrorCodes.INPUT_INVALID, e.message);
  }
  if (units <= 0n) {
    throw new NettingError(ErrorCodes.INPUT_INVALID, `rates: rate for ${ccy} must be positive`);
  }
  return units;
}
