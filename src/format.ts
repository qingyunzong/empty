/**
 * 格式化逆函数：整数分 -> 规范中文字符串。
 * 保证 parseAmount(formatCents(c)).cents === c（0 <= c <= MAX_CENTS），
 * 且 formatCents 在规范串上幂等。
 */

import { MAX_CENTS } from './parser.js';

export function formatCents(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_CENTS) {
    throw new RangeError(`分值超出可表示范围 [0, ${MAX_CENTS}]: ${cents}`);
  }
  const yuan = Math.floor(cents / 100);
  const frac = cents % 100;
  const ones = yuan % 10000;
  const wan = Math.floor(yuan / 10000) % 10000;
  const yi = Math.floor(yuan / 1e8);

  let out = '';
  if (yi > 0) out += `${yi}亿`;
  if (wan > 0) {
    if (yi > 0 && wan < 1000) out += '零';
    out += `${wan}万`;
  }
  if (ones > 0) {
    const higher = yi > 0 || wan > 0;
    // 高位存在且个段不足千位（或 亿 与个段之间空了 万 段）时补零占位
    if (higher && (ones < 1000 || (yi > 0 && wan === 0))) out += '零';
    out += String(ones);
  }
  if (out === '') out = '0';
  if (frac > 0) {
    out += '.' + (frac % 10 === 0 ? String(frac / 10) : String(frac).padStart(2, '0'));
  }
  return out;
}
