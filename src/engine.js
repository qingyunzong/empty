// Core interlock engine: dual-stream windowed join (pressure x temperature),
// sustained-duration state machine (ARM after holdMs), trip-channel correlation,
// watermark / late-sample tracking, retraction, and reverse-compensation diffing.
// Pure in-memory and fully serializable so the replay layer can snapshot it.

export const DEFAULT_CONFIG = {
  pressureTag: "PT-101",
  tempTag: "TT-201",
  pressureLimit: 1000,
  tempLimit: 180,
  windowMs: 5000,
  holdMs: 3000,
  watermarkLagMs: 1000,
};

export class UnitMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnitMissingError";
    this.code = "UNIT_MISSING";
  }
}

export class LineInvalidError extends Error {
  constructor(message) {
    super(message);
    this.name = "LineInvalidError";
    this.code = "LINE_INVALID";
  }
}

function compareSamples(a, b) {
  if (a.eventTs !== b.eventTs) return a.eventTs - b.eventTs;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.arrivalIdx - b.arrivalIdx;
}

// Latest sample of `tag` visible at time t: eventTs in (t - windowMs, t].
export function valueAt(samples, tag, t, windowMs) {
  let best = null;
  for (const s of samples) {
    if (s.tag !== tag) continue;
    if (s.eventTs > t) continue;
    if (s.eventTs <= t - windowMs) continue;
    if (best === null || compareSamples(s, best) > 0) best = s;
  }
  return best ? best.value : null;
}

export function conditionAt(samples, cfg, t) {
  const p = valueAt(samples, cfg.pressureTag, t, cfg.windowMs);
  const m = valueAt(samples, cfg.tempTag, t, cfg.windowMs);
  return p !== null && m !== null && p > cfg.pressureLimit && m > cfg.tempLimit;
}

function normalizeState(state) {
  if (state === true || state === 1 || state === "ON" || state === "on") return true;
  if (state === false || state === 0 || state === "OFF" || state === "off") return false;
  throw new LineInvalidError(`invalid trip state: ${JSON.stringify(state)}`);
}

const KIND_PRIORITY = { TRIP_CLEAR: 0, DISARM: 1, ARM: 2, TRIP: 3 };

function transitionKey(t) {
  return t.channel ? `${t.kind}:${t.channel}@${t.ts}` : `${t.kind}@${t.ts}`;
}

// Compute the full derived transition list from the current sample/trip stores.
// Deterministic pure function of (samples, tripEvents, cfg).
export function computeTransitions(samples, tripEvents, cfg) {
  const crit = new Set();
  for (const s of samples) {
    if (s.tag !== cfg.pressureTag && s.tag !== cfg.tempTag) continue;
    crit.add(s.eventTs);
    crit.add(s.eventTs + cfg.windowMs);
  }
  const times = [...crit].sort((a, b) => a - b);

  // Maximal intervals where the combined condition holds, over segments
  // between critical times (condition is constant inside each segment and
  // equal to its value at the segment's left endpoint).
  const runs = [];
  let runStart = null;
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i];
    const c = conditionAt(samples, cfg, a);
    if (c && runStart === null) runStart = a;
    if (!c && runStart !== null) {
      runs.push({ start: runStart, end: a });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ start: runStart, end: times[times.length - 1] });

  const arms = [];
  for (const r of runs) {
    if (r.end - r.start >= cfg.holdMs) {
      arms.push({ start: r.start + cfg.holdMs, end: r.end });
    }
  }

  // Trip-channel ON intervals per channel.
  const sortedTrips = [...tripEvents].sort(
    (a, b) => a.eventTs - b.eventTs || a.arrivalIdx - b.arrivalIdx,
  );
  const onIntervals = new Map();
  const onSince = new Map();
  for (const e of sortedTrips) {
    const cur = onSince.get(e.channel);
    if (e.state && cur === undefined) {
      onSince.set(e.channel, e.eventTs);
    } else if (!e.state && cur !== undefined) {
      if (!onIntervals.has(e.channel)) onIntervals.set(e.channel, []);
      onIntervals.get(e.channel).push({ start: cur, end: e.eventTs });
      onSince.delete(e.channel);
    }
  }
  for (const [ch, start] of onSince) {
    if (!onIntervals.has(ch)) onIntervals.set(ch, []);
    onIntervals.get(ch).push({ start, end: Infinity });
  }

  const transitions = [];
  for (const arm of arms) {
    transitions.push({ kind: "ARM", ts: arm.start });
    transitions.push({ kind: "DISARM", ts: arm.end });
    for (const [channel, intervals] of onIntervals) {
      for (const iv of intervals) {
        const s = Math.max(iv.start, arm.start);
        const e = Math.min(iv.end, arm.end);
        if (s < e) {
          transitions.push({ kind: "TRIP", channel, ts: s });
          transitions.push({ kind: "TRIP_CLEAR", channel, ts: e });
        }
      }
    }
  }
  transitions.sort(
    (a, b) =>
      a.ts - b.ts ||
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] ||
      String(a.channel ?? "").localeCompare(String(b.channel ?? "")),
  );
  for (const t of transitions) t.key = transitionKey(t);
  return transitions;
}

export class InterlockEngine {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.samples = [];
    this.tripEvents = [];
    this.seenIds = new Set();
    this.emitted = [];
    this.maxEventTs = null;
    this.arrivalCounter = 0;
  }

  watermark() {
    return this.maxEventTs === null ? null : this.maxEventTs - this.config.watermarkLagMs;
  }

  #lateness(eventTs) {
    const wm = this.watermark();
    // Boundary is inclusive: eventTs exactly == watermark is still on time.
    return { late: wm !== null && eventTs < wm, watermark: wm };
  }

  #advanceClock(eventTs) {
    if (this.maxEventTs === null || eventTs > this.maxEventTs) {
      this.maxEventTs = eventTs;
    }
  }

  applySensor(ev) {
    const id = ev.id;
    if (this.seenIds.has(id)) {
      return { applied: false, logs: [{ reason: "duplicate-id", id, eventTs: ev.eventTs }] };
    }
    this.seenIds.add(id);
    if (ev.op === "retract") return this.applyRetract("sensor", id, ev.eventTs);
    if (typeof ev.unit !== "string" || ev.unit === "") {
      throw new UnitMissingError(`UNIT_MISSING: sensor id=${id} tag=${ev.tag} eventTs=${ev.eventTs}`);
    }
    const { late, watermark } = this.#lateness(ev.eventTs);
    this.samples.push({
      id,
      eventTs: ev.eventTs,
      tag: ev.tag,
      value: ev.value,
      unit: ev.unit,
      seq: typeof ev.seq === "number" ? ev.seq : 0,
      arrivalIdx: this.arrivalCounter++,
    });
    this.#advanceClock(ev.eventTs);
    const logs = [];
    if (late) {
      logs.push({ reason: "late-sample", id, tag: ev.tag, eventTs: ev.eventTs, watermark });
    }
    return { applied: true, logs };
  }

  applyTrip(ev) {
    const id = ev.id;
    if (this.seenIds.has(id)) {
      return { applied: false, logs: [{ reason: "duplicate-id", id, eventTs: ev.eventTs }] };
    }
    this.seenIds.add(id);
    if (ev.op === "retract") return this.applyRetract("trip", id, ev.eventTs);
    const state = normalizeState(ev.state);
    const { late, watermark } = this.#lateness(ev.eventTs);
    this.tripEvents.push({
      id,
      eventTs: ev.eventTs,
      channel: ev.channel,
      state,
      arrivalIdx: this.arrivalCounter++,
    });
    this.#advanceClock(ev.eventTs);
    const logs = [];
    if (late) {
      logs.push({ reason: "late-trip", id, channel: ev.channel, eventTs: ev.eventTs, watermark });
    }
    return { applied: true, logs };
  }

  applyRetract(kind, id, eventTs) {
    const key = `retract:${kind}:${id}`;
    if (this.seenIds.has(key)) {
      return { applied: false, logs: [{ reason: "duplicate-retract", kind, id, eventTs }] };
    }
    this.seenIds.add(key);
    const { late, watermark } = this.#lateness(eventTs);
    const store = kind === "trip" ? this.tripEvents : this.samples;
    const idx = store.findIndex((s) => s.id === id);
    this.#advanceClock(eventTs);
    const logs = [];
    if (idx === -1) {
      logs.push({ reason: "unknown-retract", kind, id, eventTs });
    } else {
      store.splice(idx, 1);
      logs.push({ reason: "retracted", kind, id, eventTs, late, watermark });
    }
    return { applied: idx !== -1, logs };
  }

  applyEvent(ev) {
    if (ev.type === "sensor") return this.applySensor(ev);
    if (ev.type === "trip") return this.applyTrip(ev);
    if (ev.type === "retract") return this.applyRetract(ev.kind, ev.id, ev.eventTs);
    throw new LineInvalidError(`unknown event type: ${JSON.stringify(ev.type)}`);
  }

  // Recompute derived transitions and diff against what was previously emitted.
  // Returns { revoked, added }; revoked entries need reverse compensation.
  diff() {
    const next = computeTransitions(this.samples, this.tripEvents, this.config);
    const oldKeys = this.emitted.map((t) => t.key);
    const newKeys = next.map((t) => t.key);
    let k = 0;
    while (k < oldKeys.length && k < newKeys.length && oldKeys[k] === newKeys[k]) k++;
    const revoked = this.emitted.slice(k).reverse();
    const added = next.slice(k);
    this.emitted = next;
    return { revoked, added };
  }

  toJSON() {
    return {
      config: this.config,
      samples: this.samples,
      tripEvents: this.tripEvents,
      seenIds: [...this.seenIds],
      emitted: this.emitted,
      maxEventTs: this.maxEventTs,
      arrivalCounter: this.arrivalCounter,
    };
  }

  static fromJSON(data) {
    const engine = new InterlockEngine(data.config);
    engine.samples = data.samples;
    engine.tripEvents = data.tripEvents;
    engine.seenIds = new Set(data.seenIds);
    engine.emitted = data.emitted;
    engine.maxEventTs = data.maxEventTs;
    engine.arrivalCounter = data.arrivalCounter;
    return engine;
  }
}
