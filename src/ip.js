import { RiskError } from './errors.js';

export function parseIp(text, pos) {
  const parts = String(text).split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) {
    throw new RiskError('E_CIDR', `invalid IP address "${text}"`, pos);
  }
  let value = 0;
  for (const p of parts) {
    const n = Number(p);
    if (n > 255) {
      throw new RiskError('E_CIDR', `invalid IP address "${text}" (octet > 255)`, pos);
    }
    value = value * 256 + n;
  }
  return value;
}

export function parseCidr(text, pos) {
  const slash = String(text).indexOf('/');
  if (slash < 0) {
    throw new RiskError('E_CIDR', `invalid CIDR "${text}" (missing /prefix)`, pos);
  }
  const ipText = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixText)) {
    throw new RiskError('E_CIDR', `invalid CIDR prefix in "${text}"`, pos);
  }
  const prefix = Number(prefixText);
  if (prefix > 32) {
    throw new RiskError('E_CIDR', `invalid CIDR prefix /${prefix} in "${text}" (max /32)`, pos);
  }
  const base = parseIp(ipText, pos);
  const d = 2 ** (32 - prefix);
  return { base: Math.floor(base / d) * d, prefix };
}

export function cidrContains(cidr, ip) {
  const d = 2 ** (32 - cidr.prefix);
  return Math.floor(ip / d) === cidr.base / d;
}

export function cidrSubnetOf(inner, outer) {
  return inner.prefix >= outer.prefix && cidrContains(outer, inner.base);
}

export function formatIp(value) {
  return [24, 16, 8, 0].map((s) => Math.floor(value / 2 ** s) % 256).join('.');
}
