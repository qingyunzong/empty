export const QUALITY_WEIGHTS = { good: 1.0, suspect: 0.5, unknown: 0.25, bad: 0.0 };

export const TRUST = { ok: 'ok', unknown: 'unknown', fail: 'fail' };

export function weightOf(quality) {
  const w = QUALITY_WEIGHTS[quality];
  if (w === undefined) throw new Error(`unknown quality mark: ${quality}`);
  return w;
}

export function trustOf(quality) {
  if (quality === 'good') return TRUST.ok;
  if (quality === 'unknown') return TRUST.unknown;
  return TRUST.fail;
}

export function mergeTrust(a, b) {
  if (a === TRUST.fail || b === TRUST.fail) return TRUST.fail;
  if (a === TRUST.unknown || b === TRUST.unknown) return TRUST.unknown;
  return TRUST.ok;
}
