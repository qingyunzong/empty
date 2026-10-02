import { resolveParams } from './params.js';
import { validateEvents } from './schema.js';
import { normalizeReference } from './intervals.js';
import { buildTimeline, computeOee } from './analyze.js';

// Reference pipeline: brute-force enumeration of all legal atomic intervals.
// Used by the property tests to cross-check the sweep-line implementation.
export function analyzeReference(rawEvents, paramOverrides = {}) {
  const params = resolveParams(paramOverrides);
  const events = validateEvents(rawEvents);
  const timeline = buildTimeline(events, params, normalizeReference);
  return { timeline, oee: computeOee(timeline, params) };
}
