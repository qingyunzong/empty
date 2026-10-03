// Core value primitives: money (integer cents), rate (integer micro, 1e6 = 1.0),
// dates (epoch days). All arithmetic is exact BigInt math; money*rate rounds
// half-up (四舍五入) to cents.

export const RATE_SCALE = 1000000n;
export const MONEY_SCALE = 100n;

// "12.3" / "12.34" / "12" -> cents (BigInt). Caller must pre-validate format.
export function parseMoney(text) {
  const dot = text.indexOf('.');
  if (dot === -1) return BigInt(text) * MONEY_SCALE;
  const intPart = text.slice(0, dot);
  const fracPart = text.slice(dot + 1).padEnd(2, '0');
  return BigInt(intPart) * MONEY_SCALE + BigInt(fracPart);
}

// "0.06" -> 60000n (micro). Up to 6 decimal places.
export function parseRate(text) {
  const dot = text.indexOf('.');
  if (dot === -1) return BigInt(text) * RATE_SCALE;
  const intPart = text.slice(0, dot);
  const fracPart = text.slice(dot + 1).padEnd(6, '0');
  return BigInt(intPart) * RATE_SCALE + BigInt(fracPart);
}

export function formatMoney(cents) {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  return `${neg ? '-' : ''}${a / MONEY_SCALE}.${String(a % MONEY_SCALE).padStart(2, '0')}`;
}

export function formatRate(micro) {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  let frac = String(a % RATE_SCALE).padStart(6, '0').replace(/0+$/, '');
  const intPart = (a / RATE_SCALE).toString();
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

// Divide `numer` by `denom` (denom > 0), rounding half away from zero.
export function divRoundHalfUp(numer, denom) {
  const neg = numer < 0n;
  const a = neg ? -numer : numer;
  const q = (a + denom / 2n) / denom;
  return neg ? -q : q;
}

// money(cents) * rate(micro) -> money(cents), rounded half-up.
export function mulMoneyRate(cents, micro) {
  return divRoundHalfUp(cents * micro, RATE_SCALE);
}

// rate * rate -> rate, rounded half-up.
export function mulRateRate(x, y) {
  return divRoundHalfUp(x * y, RATE_SCALE);
}

// rate / rate -> rate, rounded half-up.
export function divRateRate(x, y) {
  return divRoundHalfUp(x * RATE_SCALE, y < 0n ? -y : y) * (y < 0n ? -1n : 1n);
}

export function dateToDays(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(dt.getTime() / 86400000);
}

export function daysToDate(days) {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

// Runtime value helpers. Values are tagged: {t:'m'|'r'|'d'|'b', v}.
export const money = (cents) => ({ t: 'm', v: cents });
export const rate = (micro) => ({ t: 'r', v: micro });
export const dateVal = (days) => ({ t: 'd', v: days });
export const boolVal = (b) => ({ t: 'b', v: b });

export function formatValue(val) {
  switch (val.t) {
    case 'm': return formatMoney(val.v);
    case 'r': return formatRate(val.v);
    case 'd': return daysToDate(val.v);
    case 'b': return val.v;
    default: throw new Error(`unknown value tag ${val.t}`);
  }
}
