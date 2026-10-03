import { RiskError } from './errors.js';

export function parseMoney(raw, pos) {
  const text = String(raw);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new RiskError('E_TYPE', `invalid money literal "${text}" (at most 2 decimals)`, pos);
  }
  const [intPart, frac = ''] = text.split('.');
  return Number(intPart) * 100 + Number((frac + '00').slice(0, 2));
}

export function parseCount(raw, pos) {
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new RiskError('E_TYPE', `invalid count literal "${text}" (non-negative integer expected)`, pos);
  }
  return Number(text);
}

export function formatMoney(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
