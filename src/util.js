import { createHash } from 'node:crypto';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
    this.code = 9;
  }
}

export class VerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyError';
    this.code = 8;
  }
}
