import { E } from './errors.js';

export function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

export function parseCidr(text) {
  const slash = text.indexOf('/');
  const addr = ipToInt(text.slice(0, slash));
  const bits = Number(text.slice(slash + 1));
  if (addr === null) throw E('E_CIDR', `invalid CIDR '${text}': bad address`);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32)
    throw E('E_CIDR', `invalid CIDR '${text}': prefix length must be 0..32`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  if (((addr & mask) >>> 0) !== addr)
    throw E('E_CIDR', `invalid CIDR '${text}': host bits are set`);
  return { base: addr, bits, mask };
}

export function cidrContains(cidr, ip) {
  const addr = ipToInt(ip);
  if (addr === null) return false;
  return ((addr & cidr.mask) >>> 0) === cidr.base;
}
