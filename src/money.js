'use strict';

const { ReconError, CODES } = require('./errors');

const DECIMAL_RE = /^-?(\d+)(?:\.(\d+))?$/;

// Parse a decimal string into a rational {num, den} with den a power of 10.
function parseDecimal(str, what) {
  if (typeof str !== 'string') {
    throw new ReconError(CODES.E_POLICY, `${what} must be a decimal string, got ${JSON.stringify(str)}`);
  }
  const neg = str.startsWith('-');
  const m = DECIMAL_RE.exec(str);
  if (!m) throw new ReconError(CODES.E_POLICY, `${what} is not a valid decimal: ${str}`);
  const frac = m[2] || '';
  const num = BigInt(m[1] + frac) * (neg ? -1n : 1n);
  const den = 10n ** BigInt(frac.length);
  return { num, den };
}

// Parse an amount string ("123.45") into integer minor units (cents).
function parseAmount(str, what) {
  const { num, den } = parseDecimal(str, what || 'amount');
  if (den > 100n) {
    throw new ReconError(CODES.E_POLICY,
      `${what || 'amount'} has more than 2 decimal places: ${str}`);
  }
  return num * (100n / den);
}

// round-half-up(num/den), den > 0
function divRoundHalfUp(num, den) {
  if (num >= 0n) return (num * 2n + den) / (2n * den);
  return -((-num * 2n + den) / (2n * den));
}

// Multiply minor units by a decimal rate, rounding half-up to minor units.
function applyRate(minorUnits, decimalStr, what) {
  const { num, den } = parseDecimal(decimalStr, what);
  return divRoundHalfUp(BigInt(minorUnits) * num, den);
}

module.exports = { parseDecimal, parseAmount, applyRate, divRoundHalfUp };
