export const DEFAULTS = {
  minC: -30,
  maxC: 8,
  shortWindowMs: 300000,
};

function groupByZone(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.zone)) map.set(e.zone, []);
    map.get(e.zone).push(e);
  }
  return map;
}

export function minimumCovers(universeSize, coverage) {
  const lots = [...coverage.keys()].sort();
  if (universeSize === 0) return { minimumSize: 0, solutions: [[]] };

  const masks = lots.map((lot) => {
    let mask = 0n;
    for (const idx of coverage.get(lot)) mask |= 1n << BigInt(idx);
    return mask;
  });
  const full = (1n << BigInt(universeSize)) - 1n;
  const solutions = [];
  const combo = [];

  const search = (startIdx, targetSize) => {
    if (combo.length === targetSize) {
      let mask = 0n;
      for (const i of combo) mask |= masks[i];
      if (mask === full) solutions.push(combo.map((i) => lots[i]));
      return;
    }
    const remaining = targetSize - combo.length;
    for (let i = startIdx; i <= lots.length - remaining; i++) {
      combo.push(i);
      search(i + 1, targetSize);
      combo.pop();
    }
  };

  for (let size = 0; size <= lots.length; size++) {
    search(0, size);
    if (solutions.length > 0) return { minimumSize: size, solutions };
  }
  return { minimumSize: null, solutions: [] };
}

export function analyze(events, options = {}) {
  const { minC, maxC, shortWindowMs } = { ...DEFAULTS, ...options };
  const watermark = options.watermark ?? null;

  const repairs = events
    .filter((e) => e.kind === 'repair')
    .sort((a, b) => a.eventTs - b.eventTs);
  const sensorTrusted = (sensor, ts) => {
    let trusted = true;
    for (const r of repairs) {
      if (r.eventTs > ts) break;
      if (r.sensor === sensor) trusted = r.ok;
    }
    return trusted;
  };

  const windows = [];
  const tempsByZone = groupByZone(events.filter((e) => e.kind === 'temp'));
  for (const [zone, list] of tempsByZone) {
    const trusted = list
      .filter((t) => sensorTrusted(t.sensor, t.eventTs))
      .sort((a, b) => a.eventTs - b.eventTs || a.id.localeCompare(b.id));
    let openStart = null;
    for (const t of trusted) {
      const bad = t.c < minC || t.c > maxC;
      if (bad && openStart === null) openStart = t.eventTs;
      else if (!bad && openStart !== null) {
        windows.push({ zone, start: openStart, end: t.eventTs });
        openStart = null;
      }
    }
    if (openStart !== null && watermark !== null) {
      windows.push({ zone, start: openStart, end: watermark });
    }
  }

  const clipped = [];
  for (const w of windows) {
    let { start, end } = w;
    if (watermark !== null) {
      if (start >= watermark) continue;
      end = Math.min(end, watermark);
    }
    if (end <= start) continue;
    clipped.push({ zone: w.zone, start, end });
  }
  clipped.sort((a, b) => a.start - b.start || a.zone.localeCompare(b.zone));

  const doorIntervals = [];
  const doorsByZone = groupByZone(events.filter((e) => e.kind === 'door'));
  for (const [zone, list] of doorsByZone) {
    const sorted = [...list].sort((a, b) => a.eventTs - b.eventTs || a.id.localeCompare(b.id));
    let openStart = null;
    for (const d of sorted) {
      if (d.open && openStart === null) openStart = d.eventTs;
      else if (!d.open && openStart !== null) {
        doorIntervals.push({ zone, start: openStart, end: d.eventTs });
        openStart = null;
      }
    }
    if (openStart !== null && watermark !== null && openStart < watermark) {
      doorIntervals.push({ zone, start: openStart, end: watermark });
    }
  }

  const explained = [];
  const unexplained = [];
  for (const w of clipped) {
    const durationMs = w.end - w.start;
    const door = doorIntervals.find(
      (d) => d.zone === w.zone && d.start <= w.end && d.end >= w.start,
    );
    if (durationMs <= shortWindowMs && door) {
      explained.push({ ...w, durationMs, doorStart: door.start, doorEnd: door.end });
    } else {
      unexplained.push({ ...w, durationMs });
    }
  }

  const ships = events.filter((e) => e.kind === 'ship');
  const exposures = [];
  for (const w of unexplained) {
    w.exposedLots = [];
    for (const s of ships) {
      if (s.zone !== w.zone) continue;
      if (s.start < w.end && s.end > w.start) {
        w.exposedLots.push(s.lot);
        exposures.push({
          lot: s.lot,
          zone: w.zone,
          windowStart: w.start,
          windowEnd: w.end,
          shipId: s.id,
          shipStart: s.start,
          shipEnd: s.end,
        });
      }
    }
    w.exposedLots.sort();
  }

  const coverage = new Map();
  unexplained.forEach((w, idx) => {
    for (const lot of w.exposedLots) {
      if (!coverage.has(lot)) coverage.set(lot, new Set());
      coverage.get(lot).add(idx);
    }
  });
  const cover = minimumCovers(unexplained.length, coverage);
  const exposedLots = [...coverage.keys()].sort();

  return { windows: clipped, explained, unexplained, exposures, exposedLots, cover, watermark };
}
