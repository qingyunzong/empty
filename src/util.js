import { createHash } from 'node:crypto';

export const SCALE = 100000000n; // 1e8 fixed-point scale

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

export function parseDecimal(text, code = 'INVALID_AMOUNT') {
  if (typeof text !== 'string' || !/^-?\d+(\.\d{1,8})?$/.test(text)) {
    throw new LedgerError(code, `invalid decimal: ${text}`);
  }
  const negative = text.startsWith('-');
  const [intPart, fracPart = ''] = text.replace('-', '').split('.');
  const scaled = BigInt(intPart) * SCALE + BigInt((fracPart + '00000000').slice(0, 8));
  return negative ? -scaled : scaled;
}

export function formatDecimal(scaled) {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / SCALE;
  const fracPart = (abs % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + intPart.toString() + (fracPart ? '.' + fracPart : '');
}
