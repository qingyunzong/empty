import { ClearingError, CODES } from './errors.js';

// Rates are integers scaled by SCALE: rate 1.10 is stored as 1100000.
// Conversion to base uses exact BigInt arithmetic, rounding half-up.
export const SCALE = 1000000n;

export function toBase(amount, rateScaled) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new ClearingError(CODES.INVALID_INPUT, `invalid amount: ${amount}`);
  }
  if (!Number.isSafeInteger(rateScaled) || rateScaled <= 0) {
    throw new ClearingError(CODES.INVALID_INPUT, `invalid rate: ${rateScaled}`);
  }
  const v = (BigInt(amount) * BigInt(rateScaled) + SCALE / 2n) / SCALE;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ClearingError(CODES.INVALID_INPUT, 'converted amount overflows safe integer');
  }
  return Number(v);
}

// Versioned FX table. Versions are positive integers, strictly increasing.
// Registering a version <= latest, or settling with a version < latest,
// raises RATE_STALE.
export class RateBook {
  #versions = new Map();
  #latest = 0;

  constructor(base) {
    if (typeof base !== 'string' || base.length === 0) {
      throw new ClearingError(CODES.INVALID_INPUT, 'base currency required');
    }
    this.base = base;
  }

  get latestVersion() {
    return this.#latest;
  }

  has(version) {
    return this.#versions.has(version);
  }

  addVersion(version, rates) {
    if (!Number.isInteger(version) || version <= 0) {
      throw new ClearingError(CODES.INVALID_INPUT, `version must be a positive integer, got ${version}`);
    }
    if (version <= this.#latest) {
      throw new ClearingError(CODES.RATE_STALE, `rate version ${version} is not newer than ${this.#latest}`, {
        requested: version,
        latest: this.#latest,
      });
    }
    if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) {
      throw new ClearingError(CODES.INVALID_INPUT, 'rates must be an object');
    }
    const clean = {};
    for (const ccy of Object.keys(rates).sort()) {
      const r = rates[ccy];
      if (!Number.isSafeInteger(r) || r <= 0) {
        throw new ClearingError(CODES.INVALID_INPUT, `rate for ${ccy} must be a positive integer (scaled by 1e6)`);
      }
      clean[ccy] = r;
    }
    if (clean[this.base] !== Number(SCALE)) {
      throw new ClearingError(CODES.INVALID_INPUT, `rates must fix ${this.base} at ${Number(SCALE)}`);
    }
    this.#versions.set(version, clean);
    this.#latest = version;
  }

  // Raw access without staleness check (used to build corrections).
  raw(version) {
    const r = this.#versions.get(version);
    if (r === undefined) {
      throw new ClearingError(CODES.INVALID_INPUT, `unknown rate version ${version}`);
    }
    return r;
  }

  // Settlement access: only the latest version is usable.
  current(version) {
    if (!this.#versions.has(version)) {
      throw new ClearingError(CODES.INVALID_INPUT, `unknown rate version ${version}`);
    }
    if (version < this.#latest) {
      throw new ClearingError(CODES.RATE_STALE, `rate version ${version} is stale; latest is ${this.#latest}`, {
        requested: version,
        latest: this.#latest,
      });
    }
    return this.#versions.get(version);
  }
}
