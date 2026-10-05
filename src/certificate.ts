import { createHash } from 'node:crypto';
import type { State } from './state.js';

/** 键序稳定的规范化序列化，保证同一状态必然得到同一串 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** 状态证书：最终状态 + 事件数的 SHA-256 摘要 */
export function stateCertificate(state: State, eventCount: number): string {
  return createHash('sha256').update(canonicalize({ eventCount, state })).digest('hex');
}
