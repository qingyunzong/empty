import { createHash } from 'node:crypto';
import { OeeError, ERR, errJson } from './errors.js';
import { validateParams, validateEvents, checkClock } from './validate.js';
import { buildTimeline, computeOee } from './timeline.js';
import { injectFaults } from './inject.js';

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') +
    '}'
  );
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// analyze({ events, params?, injection? }) ->
//   { ok: true, timeline, oee, certificate } | { ok: false, error: { code, message } }
export function analyze(input) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new OeeError(ERR.SCHEMA, 'input must be an object { events, params?, injection? }');
    }
    const params = validateParams(input.params ?? {});
    const rawEvents = input.events ?? [];
    let events = validateEvents(rawEvents);
    let injection = null;
    if (input.injection) {
      const res = injectFaults(events, input.injection);
      events = validateEvents(res.events); // re-dedup: injected exact duplicates collapse
      injection = res.injection;
    }
    checkClock(events, params); // arrival order = array order
    const active = events.filter((e) => e.end > e.start); // zero-duration events carry no interval
    const timeline = buildTimeline(active, params);
    const oee = computeOee(timeline, params);
    const certificate = {
      version: 1,
      params,
      injection,
      inputHash: sha256(canonical(rawEvents)),
      outputHash: sha256(canonical({ timeline, oee })),
    };
    return { ok: true, timeline, oee, certificate };
  } catch (e) {
    if (e instanceof OeeError) return errJson(e);
    throw e;
  }
}

// Re-apply the certificate's injection to the original events and verify hashes.
export function replay(certificate, rawEvents) {
  const again = analyze({
    events: rawEvents,
    params: certificate.params,
    ...(certificate.injection ? { injection: certificate.injection } : {}),
  });
  if (!again.ok) return { ok: true, match: false, reason: again.error };
  return {
    ok: true,
    match:
      again.certificate.outputHash === certificate.outputHash &&
      again.certificate.inputHash === certificate.inputHash,
    outputHash: again.certificate.outputHash,
  };
}
