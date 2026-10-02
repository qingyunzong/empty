import { RETRACT_OPS } from './parse.js';
import { minimumSetCovers } from './setcover.js';

export const DEFAULT_CONFIG = {
  maxC: -15,
  allowedLatenessMs: 2 * 60 * 1000,
  segmentGapMs: 15 * 60 * 1000,
  doorGraceMs: 5 * 60 * 1000,
  maxExplainableMs: 20 * 60 * 1000,
  maxExactCandidates: 24,
};

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function applyEvent(state, event) {
  if (event.type === 'retract') {
    const key = `${event.kind}:${event.id}`;
    const target = state.live.get(key);
    if (target) state.live.delete(key);
    return;
  }
  if (RETRACT_OPS.has(event.op)) {
    const key = `${event.type}:${event.id}`;
    if (state.live.has(key)) state.live.delete(key);
    return;
  }
  if (event.id !== undefined && event.id !== null) {
    state.live.set(`${event.type}:${event.id}`, event);
  } else {
    state.anonymous.push(event);
  }
}

export function analyze(events, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const state = { live: new Map(), anonymous: [] };
  const late = [];
  let maxEventTs = null;

  for (const event of events) {
    if (maxEventTs === null || event.eventTs > maxEventTs) maxEventTs = event.eventTs;
    const watermark = maxEventTs - config.allowedLatenessMs;
    if (event.eventTs < watermark) {
      late.push({ event, watermark, maxEventTs });
      continue;
    }
    applyEvent(state, event);
  }

  const liveEvents = [...state.live.values(), ...state.anonymous];
  const temps = liveEvents.filter((event) => event.type === 'temp');
  const doors = liveEvents.filter((event) => event.type === 'door');
  const ships = liveEvents.filter((event) => event.type === 'ship');
  const repairs = liveEvents.filter((event) => event.type === 'repair');

  const trustBoundary = new Map();
  for (const repair of repairs) {
    if (!repair.ok) continue;
    const current = trustBoundary.get(repair.sensor);
    if (current === undefined || repair.eventTs > current) trustBoundary.set(repair.sensor, repair.eventTs);
  }

  const trustedTemps = temps.filter((reading) => {
    const boundary = trustBoundary.get(reading.zone);
    return boundary === undefined || reading.eventTs > boundary;
  });
  const dismissedReadings = temps.length - trustedTemps.length;

  const windows = buildWindows(trustedTemps, config);
  for (const window of windows) {
    window.explainedBy = explainWindow(window, doors, config);
  }

  const lots = new Map();
  for (const ship of ships) {
    if (!lots.has(ship.lot)) lots.set(ship.lot, []);
    lots.get(ship.lot).push(ship);
  }

  const unexplained = [];
  const evidence = [];
  for (const window of windows) {
    if (window.explainedBy) continue;
    const exposedLots = [];
    for (const [lot, shipments] of lots) {
      for (const ship of shipments) {
        if (ship.zone !== window.zone) continue;
        if (!overlaps(ship.start, ship.end, window.start, window.end)) continue;
        if (!exposedLots.includes(lot)) exposedLots.push(lot);
        evidence.push({
          lot,
          zone: ship.zone,
          shipStart: ship.start,
          shipEnd: ship.end,
          windowStart: window.start,
          windowEnd: window.end,
          maxC: window.maxC,
          reason: 'temp-exceedance',
        });
      }
    }
    exposedLots.sort();
    unexplained.push({ ...window, lots: exposedLots });
  }

  const cover = minimumSetCovers(
    unexplained.map((window) => ({ lots: window.lots })),
    { maxExactCandidates: config.maxExactCandidates },
  );

  const coverable = unexplained.filter((window) => window.lots.length > 0).length;
  const uncoveredWindows = unexplained.filter((window) => window.lots.length === 0);
  const recalledLots = new Set(cover.solutions.flat());
  const finalEvidence = evidence.filter((record) => recalledLots.has(record.lot));

  return {
    config,
    watermark: maxEventTs === null ? null : maxEventTs - config.allowedLatenessMs,
    maxEventTs,
    counts: {
      events: liveEvents.length,
      tempReadings: temps.length,
      dismissedReadings,
      windows: windows.length,
      explainedWindows: windows.filter((window) => window.explainedBy).length,
      unexplainedWindows: unexplained.length,
      coverableWindows: coverable,
      lateEvents: late.length,
    },
    windows,
    unexplained,
    uncoveredWindows,
    evidence: finalEvidence,
    late,
    recall: {
      minimalSize: cover.size,
      exact: cover.exact,
      solutions: cover.solutions,
      lots: cover.solutions.length > 0 ? cover.solutions[0] : [],
    },
  };
}

function buildWindows(temps, config) {
  const byZone = new Map();
  for (const reading of temps) {
    if (!byZone.has(reading.zone)) byZone.set(reading.zone, []);
    byZone.get(reading.zone).push(reading);
  }

  const windows = [];
  for (const [zone, readings] of byZone) {
    readings.sort((a, b) => a.eventTs - b.eventTs);
    let current = null;
    const closeWindow = (endTs) => {
      if (!current) return;
      const end = endTs ?? current.lastTs;
      windows.push({
        zone,
        start: current.start,
        end,
        maxC: round3(current.maxC),
        readings: current.readings,
        explainedBy: null,
      });
      current = null;
    };

    for (const reading of readings) {
      const over = reading.c > config.maxC;
      if (over) {
        if (current && reading.eventTs - current.lastTs > config.segmentGapMs) closeWindow();
        if (!current) {
          current = { start: reading.eventTs, lastTs: reading.eventTs, maxC: reading.c, readings: 0 };
        }
        current.lastTs = reading.eventTs;
        current.maxC = Math.max(current.maxC, reading.c);
        current.readings += 1;
      } else {
        closeWindow(reading.eventTs);
      }
    }
    closeWindow();
  }

  windows.sort((a, b) => a.start - b.start || (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0));
  return windows;
}

function explainWindow(window, doors, config) {
  if (window.end - window.start > config.maxExplainableMs) return null;
  const candidates = doors
    .filter((door) => door.zone === window.zone && door.open)
    .filter((door) => door.eventTs >= window.start - config.doorGraceMs && door.eventTs <= window.end)
    .sort((a, b) => a.eventTs - b.eventTs);
  if (candidates.length === 0) return null;
  const door = candidates[0];
  return { type: 'door-open', zone: door.zone, eventTs: door.eventTs, id: door.id ?? null };
}
