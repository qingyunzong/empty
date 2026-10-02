// Fixed-point decimal arithmetic on BigInt, SCALE = 10^6 ("minor units").
// All engine math happens here so results are exact and deterministic.

export const SCALE = 1_000_000n;
export const HALF = SCALE / 2n;

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

export function toUnits(value, what = 'value') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`invalid decimal ${what}: ${value}`);
    }
    value = String(value);
  }
  if (typeof value !== 'string') {
    throw new Error(`invalid decimal ${what}: expected string or number`);
  }
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) {
    throw new Error(`invalid decimal ${what}: ${JSON.stringify(value)} (max 6 fractional digits)`);
  }
  const [, sign, intPart, fracPart = ''] = m;
  const frac6 = (fracPart + '000000').slice(0, 6);
  let units = BigInt(intPart) * SCALE + BigInt(frac6);
  if (sign === '-') units = -units;
  return units;
}

// Multiply two scaled values (amount-units * rate-units), round half-up.
// Both operands must be non-negative.
export function mulUnits(a, b) {
  if (a < 0n || b < 0n) throw new Error('mulUnits: negative operand');
  return (a * b + HALF) / SCALE;
}

export function fmt(units) {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const intPart = u / SCALE;
  const frac = (u % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + intPart.toString() + (frac ? '.' + frac : '');
}
