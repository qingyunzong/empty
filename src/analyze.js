import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateEvents } from './schema.js';
import { resolveParams } from './params.js';
import { normalizeSweep } from './intervals.js';
import { decideWinner, classifyInterval, thresholdFor } from './classify.js';
import { injectFaults, replayInjections } from './inject.js';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestEvents(events) {
  return createHash('sha256').update(canonical(events)).digest('hex');
}

// Build the labeled timeline from validated events.
// `normalize` is injectable so the reference enumerator can reuse this path.
export function buildTimeline(events, params, normalize = normalizeSweep) {
  const enriched = events.map((e) => ({ ...e, priority: params.priorities[e.type] }));
  const byId = new Map(enriched.map((e) => [e.id, e]));
  const raw = normalize(enriched);
  const winners = raw.map((iv) => decideWinner(iv.covering.map((id) => byId.get(id))));

  // Merged-span duration of the winning type's connected coverage component.
  // Thresholds apply to the whole connected span, not to a single atomic slice.
  const spans = new Array(raw.length).fill(0);
  const coversType = (j, type) => raw[j].covering.some((id) => byId.get(id).type === type);
  for (let i = 0; i < raw.length; i++) {
    const w = winners[i];
    if (!w) continue;
    let lo = i;
    let hi = i;
    while (lo > 0 && coversType(lo - 1, w.type)) lo--;
    while (hi < raw.length - 1 && coversType(hi + 1, w.type)) hi++;
    let duration = 0;
    for (let j = lo; j <= hi; j++) duration += raw[j].end - raw[j].start;
    spans[i] = duration;
  }

  return raw.map((iv, i) => {
    const w = winners[i];
    const durationMs = iv.end - iv.start;
    const coveringEventIds = [...iv.covering].sort();
    if (!w) {
      return {
        start: iv.start,
        end: iv.end,
        durationMs,
        state: 'uncovered',
        planned: null,
        downtime: false,
        rule: 'uncovered-gap',
        winnerEventIds: [],
        coveringEventIds,
        spanDurationMs: 0,
        thresholdMs: null,
      };
    }
    const label = classifyInterval(w.type, spans[i], params);
    return {
      start: iv.start,
      end: iv.end,
      durationMs,
      state: w.type,
      ...label,
      winnerEventIds: w.eventIds,
      coveringEventIds,
      spanDurationMs: spans[i],
      thresholdMs: thresholdFor(w.type, params),
    };
  });
}

export function computeOee(timeline, params) {
  const totals = { runMs: 0, plannedDowntimeMs: 0, unplannedDowntimeMs: 0, uncoveredMs: 0 };
  for (const iv of timeline) {
    if (iv.state === 'uncovered') totals.uncoveredMs += iv.durationMs;
    else if (!iv.downtime) totals.runMs += iv.durationMs;
    else if (iv.planned) totals.plannedDowntimeMs += iv.durationMs;
    else totals.unplannedDowntimeMs += iv.durationMs;
  }
  const windowMs = timeline.length ? timeline[timeline.length - 1].end - timeline[0].start : 0;
  const excludedMs = totals.plannedDowntimeMs + (params.uncovered === 'excluded' ? totals.uncoveredMs : 0);
  const unplannedDowntimeTotalMs =
    totals.unplannedDowntimeMs + (params.uncovered === 'unplanned' ? totals.uncoveredMs : 0);
  const plannedProductionTimeMs = windowMs - excludedMs;
  const availability =
    plannedProductionTimeMs > 0
      ? (plannedProductionTimeMs - unplannedDowntimeTotalMs) / plannedProductionTimeMs
      : null;
  const oee = availability === null ? null : availability * params.performance * params.quality;
  return {
    windowMs,
    ...totals,
    plannedProductionTimeMs,
    unplannedDowntimeTotalMs,
    availability,
    performance: params.performance,
    quality: params.quality,
    oee,
  };
}

// Full offline pipeline -> JSON certificate.
// options.injection = { spec, seed } applies replayable fault injection first.
export function analyze(rawEvents, paramOverrides = {}, options = {}) {
  const params = resolveParams(paramOverrides);
  const validated = validateEvents(rawEvents);

  let events = validated;
  let injection = null;
  if (options.injection) {
    const { spec = {}, seed = 1 } = options.injection;
    const result = injectFaults(validated, spec, seed);
    const replayed = replayInjections(validated, result.log);
    injection = {
      seed,
      spec,
      log: result.log,
      replayVerified: isDeepStrictEqual(replayed, result.events),
    };
    events = result.events;
  }

  const timeline = buildTimeline(events, params);
  return {
    version: 1,
    kind: 'oee-certificate',
    params,
    input: { eventCount: events.length, sha256: digestEvents(events) },
    injection,
    timeline,
    oee: computeOee(timeline, params),
  };
}
