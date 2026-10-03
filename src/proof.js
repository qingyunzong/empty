import crypto from 'node:crypto';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export const INITIAL_PROOF = sha256('clearing:genesis');

export function computeProof(prevProof, roundCore) {
  return sha256(`${prevProof}\n${canonical(roundCore)}`);
}
