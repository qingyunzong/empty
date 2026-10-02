// Valid times are stored as epoch milliseconds; ISO-8601 strings sort
// identically to their epoch values, but numbers avoid all ambiguity.
export function toMs(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return Math.trunc(t);
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new Error(`invalid time: ${JSON.stringify(t)} (expected epoch ms or ISO-8601)`);
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}
