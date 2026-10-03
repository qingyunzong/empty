// Independent reference implementation of the event-trace state machine.
// Written separately from src/engine.js (reduce-style, no shared code) so the
// enumeration cross-check in test/reference.test.js is meaningful.
const KINDS = new Set(['quality.hold', 'quality.release', 'quality.check', 'device.alarm', 'device.clear']);

function valid(e) {
  return (
    e !== null && typeof e === 'object' && !Array.isArray(e) &&
    typeof e.id === 'string' && e.id.length > 0 &&
    typeof e.ts === 'number' && Number.isFinite(e.ts) &&
    typeof e.device === 'string' && e.device.length > 0 &&
    typeof e.lot === 'string' && e.lot.length > 0 &&
    KINDS.has(e.kind) &&
    (e.payload === undefined || (e.payload !== null && typeof e.payload === 'object' && !Array.isArray(e.payload))) &&
    (e.parents === undefined || (Array.isArray(e.parents) && e.parents.every((p) => typeof p === 'string')))
  );
}

function normalizeLot(lot) {
  return {
    quality: lot.quality,
    devices: Object.fromEntries(Object.entries(lot.devices).map(([d, i]) => [d, i.status])),
    holds: lot.holds.map((h) => `${h.eventId}:${h.auto}`),
    overridden: lot.overridden.map((o) => `${o.event}>${o.by}`).sort(),
    applied: [...lot.applied].sort(),
    lastRelease: lot.lastRelease,
  };
}

export function referenceRun(input, { windowMs = 300000 } = {}) {
  const byId = new Map();
  for (const e of input) {
    if (!valid(e)) continue;
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  const events = [...byId.values()].sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.id < b.id ? -1 : 1));

  const known = new Map();
  const applied = new Set();
  const rejected = new Map();
  const pending = new Map();
  const lots = new Map();
  const late = [];
  let watermark = null;

  function ancestors(id) {
    const seen = new Set();
    const unknown = [];
    let cycle = false;
    const stack = [...(known.get(id) ?? [])];
    while (stack.length) {
      const c = stack.pop();
      if (c === id) { cycle = true; continue; }
      if (seen.has(c)) continue;
      if (!known.has(c)) { unknown.push(c); continue; }
      seen.add(c);
      for (const p of known.get(c)) stack.push(p);
    }
    return { seen, unknown, cycle };
  }
  const isAnc = (a, b) => a !== b && ancestors(b).seen.has(a);

  function transition(lot, e) {
    const autoHold = () => {
      if (lot.quality === 'ok') {
        lot.quality = 'hold';
        lot.holds.push({ eventId: e.id, auto: true });
        return null;
      }
      if (lot.quality === 'hold') {
        lot.holds.push({ eventId: e.id, auto: true });
        return null;
      }
      const r = lot.lastRelease;
      if (r && isAnc(r, e.id)) return 'out-of-tolerance after release';
      lot.quality = 'hold';
      lot.holds.push({ eventId: e.id, auto: true });
      if (r) {
        lot.overridden.push({ event: r, by: e.id });
        lot.lastRelease = null;
      }
      return null;
    };
    switch (e.kind) {
      case 'quality.check': {
        const res = e.payload?.result;
        if (res !== 'pass' && res !== 'fail') return 'bad check result';
        if (res === 'pass') return null;
        return autoHold();
      }
      case 'quality.hold': {
        if (e.payload?.auto === true) return autoHold();
        if (lot.quality !== 'ok') return 'cannot hold';
        lot.quality = 'hold';
        lot.holds.push({ eventId: e.id, auto: false });
        return null;
      }
      case 'quality.release': {
        if (lot.quality === 'ok') return 'release without hold';
        if (lot.quality === 'released') return 'already released';
        const h = lot.holds[lot.holds.length - 1];
        if (h && h.auto && !isAnc(h.eventId, e.id)) {
          lot.overridden.push({ event: e.id, by: h.eventId });
          return null;
        }
        lot.quality = 'released';
        lot.holds = [];
        lot.lastRelease = e.id;
        return null;
      }
      case 'device.alarm': {
        const d = lot.devices[e.device];
        if (d && d.status === 'alarming') return 'already alarming';
        lot.devices[e.device] = { status: 'alarming', event: e.id };
        return null;
      }
      case 'device.clear': {
        const d = lot.devices[e.device];
        if (!d || d.status !== 'alarming') return 'not alarming';
        lot.devices[e.device] = { status: 'clear', event: e.id };
        return null;
      }
      default:
        return 'unknown kind';
    }
  }

  function apply(e) {
    if (applied.has(e.id) || pending.has(e.id) || rejected.has(e.id)) return;
    known.set(e.id, Array.isArray(e.parents) ? e.parents : []);
    const anc = ancestors(e.id);
    if (anc.cycle || anc.unknown.length > 0) {
      pending.set(e.id, e);
      return;
    }
    if (watermark !== null && e.ts < watermark - windowMs) late.push(e.id);
    const lot = lots.get(e.lot) ?? { lot: e.lot, quality: 'ok', devices: {}, holds: [], applied: [], overridden: [], lastRelease: null };
    const err = transition(lot, e);
    if (err) {
      rejected.set(e.id, err);
      return;
    }
    lot.applied.push(e.id);
    lots.set(e.lot, lot);
    applied.add(e.id);
    watermark = watermark === null ? e.ts : Math.max(watermark, e.ts);
  }

  for (const e of events) apply(e);
  let progress = true;
  while (progress) {
    progress = false;
    for (const [id, e] of [...pending.entries()]) {
      const anc = ancestors(id);
      if (anc.cycle || anc.unknown.length > 0) continue;
      pending.delete(id);
      apply(e);
      progress = true;
    }
  }

  return {
    lots: Object.fromEntries([...lots.entries()].map(([k, v]) => [k, normalizeLot(v)])),
    applied: [...applied].sort(),
    rejected: [...rejected.keys()].sort(),
    pending: [...pending.keys()].sort(),
    late: [...late].sort(),
    watermark,
  };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
