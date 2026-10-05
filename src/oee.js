export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000;

export class HoldInFinalStateError extends Error {
  constructor(pending) {
    super(`hold contains ${pending.length} pending event(s); refusing to finalize OEE`);
    this.name = 'HoldInFinalStateError';
    this.code = 'ERR_HOLD_IN_FINAL_STATE';
    this.pending = pending;
  }
}

/**
 * Split events into accepted vs held. An event is held when its clock is
 * outside the bounded-skew window relative to `now`. Held events must not
 * be counted as losses and must not be judged as violations.
 */
export function partitionBySkew(events, { now = Date.now(), maxSkewMs = DEFAULT_MAX_SKEW_MS } = {}) {
  const accepted = [];
  const held = [];
  for (const event of events) {
    const ts = event.ts ?? event.start ?? null;
    const parsed = ts === null ? NaN : Date.parse(ts);
    if (!Number.isFinite(parsed)) {
      accepted.push(event);
      continue;
    }
    if (Math.abs(parsed - now) > maxSkewMs) {
      held.push({ ...event, holdReason: 'clock-skew-out-of-bounds', skewMs: parsed - now });
    } else {
      accepted.push(event);
    }
  }
  return { accepted, held };
}

/**
 * Compute OEE from a merged store.
 *
 * availability = (planned - downtime) / planned
 * performance  = produced / (idealRatePerMin * (planned - downtime))
 * quality      = (produced - rejected) / produced   (rejected clamped to produced)
 *
 * Pending held events are excluded from every figure; if `pending` is
 * non-empty and `allowPending` is false, finalizing is refused (exit 11).
 */
export function computeOee(store, options = {}) {
  const {
    plannedMinutes = 480,
    idealRatePerMin = 1,
    shiftStart = null,
    shiftEnd = null,
    pending = [],
    allowPending = false,
  } = options;

  if (pending.length > 0 && !allowPending) {
    throw new HoldInFinalStateError(pending);
  }

  const windowStart = shiftStart === null ? null : Date.parse(shiftStart);
  const windowEnd = shiftEnd === null ? null : Date.parse(shiftEnd);

  let downtimeMs = 0;
  for (const interval of store.mergedDowntimeIntervals()) {
    const start = windowStart === null ? interval.start : Math.max(interval.start, windowStart);
    const end = windowEnd === null ? interval.end : Math.min(interval.end, windowEnd);
    if (end > start) downtimeMs += end - start;
  }
  const downtimeMinutes = downtimeMs / 60000;
  const runMinutes = Math.max(0, plannedMinutes - downtimeMinutes);

  const produced = store.produced();
  const rejectedRaw = store.rejected();
  const rejectedClamped = rejectedRaw > produced;
  const rejected = Math.min(rejectedRaw, produced);

  const available = plannedMinutes > 0 ? runMinutes / plannedMinutes : 0;
  const idealOutput = idealRatePerMin * runMinutes;
  const performance = idealOutput > 0 ? produced / idealOutput : 0;
  const quality = produced > 0 ? (produced - rejected) / produced : 1;

  return {
    available,
    performance,
    quality,
    oee: available * performance * quality,
    produced,
    rejected,
    rejectedClamped,
    downtimeMinutes,
    runMinutes,
    plannedMinutes,
    pending: pending.map((event) => event.id),
  };
}
