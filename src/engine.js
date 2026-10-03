// event-trace core engine: pure, no IO. Persistence lives in store.js.
export const KINDS = new Set(['quality.hold', 'quality.release', 'quality.check', 'device.alarm', 'device.clear']);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
  }
}

export function validateEvent(e) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'event must be an object';
  if (typeof e.id !== 'string' || e.id.length === 0) return 'id must be a non-empty string';
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return 'ts must be a finite number';
  if (typeof e.device !== 'string' || e.device.length === 0) return 'device must be a non-empty string';
  if (typeof e.lot !== 'string' || e.lot.length === 0) return 'lot must be a non-empty string';
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) return `kind must be one of ${[...KINDS].join(', ')}`;
  if (e.payload !== undefined && (e.payload === null || typeof e.payload !== 'object' || Array.isArray(e.payload))) return 'payload must be an object';
  if (e.parents !== undefined && (!Array.isArray(e.parents) || e.parents.some((p) => typeof p !== 'string'))) return 'parents must be an array of strings';
  return null;
}

export function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function emptyReport() {
  return { received: 0, malformed: [], duplicates: [], applied: [], overridden: [], late: [], rejected: [], pending: [] };
}

export function collectRecord(report, rec) {
  if (rec.decision === 'applied') {
    report.applied.push(rec.id);
    if (rec.late) report.late.push(rec.id);
  } else if (rec.decision === 'overridden') {
    report.overridden.push(rec.id);
  } else if (rec.decision === 'rejected') {
    report.rejected.push({ id: rec.id, error: rec.error });
  } else if (rec.decision === 'pending') {
    if (!report.pending.includes(rec.id)) report.pending.push(rec.id);
  } else if (rec.decision === 'duplicate') {
    report.duplicates.push(rec.id);
  }
}

function newLot(lot) {
  return { lot, quality: 'ok', devices: {}, holds: [], applied: [], history: [], overridden: [], locks: [], lastRelease: null };
}

export function createEngine({ windowMs = 300000 } = {}) {
  const applied = [];
  const appliedSet = new Set();
  const known = new Map(); // id -> parents[]
  const lots = new Map();
  const pending = []; // {event, reason, missing}
  const rejected = []; // {id, error}
  const rejectedSet = new Set();
  const audit = [];
  let watermark = null;
  let seq = 0;

  function analyzeAncestors(id) {
    const set = new Set();
    const unknown = [];
    const unknownSet = new Set();
    let cycle = false;
    const stack = [...(known.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === id) { cycle = true; continue; }
      if (set.has(cur)) continue;
      const parents = known.get(cur);
      if (!parents) {
        if (!unknownSet.has(cur)) { unknownSet.add(cur); unknown.push(cur); }
        continue;
      }
      set.add(cur);
      for (const p of parents) stack.push(p);
    }
    return { set, unknown, cycle };
  }

  function isAncestor(a, b) {
    if (a === b) return false;
    return analyzeAncestors(b).set.has(a);
  }

  function refreshLocks(lot) {
    lot.locks = [];
    for (const h of lot.holds) lot.locks.push({ type: 'quality-hold', event: h.eventId, auto: h.auto, reason: h.reason });
    for (const [device, info] of Object.entries(lot.devices)) {
      if (info.status === 'alarming') lot.locks.push({ type: 'device-alarm', device, event: info.event, code: info.code ?? null });
    }
  }

  function currentHold(lot) {
    return lot.holds.length ? lot.holds[lot.holds.length - 1] : null;
  }

  function pushHold(lot, e, auto) {
    lot.quality = 'hold';
    lot.holds.push({ eventId: e.id, auto, reason: e.payload?.reason ?? (auto ? 'auto out-of-tolerance' : 'manual hold') });
  }

  function autoHold(lot, e) {
    if (lot.quality === 'ok') {
      pushHold(lot, e, true);
      return { change: 'auto-hold', note: 'auto hold: out-of-tolerance' };
    }
    if (lot.quality === 'hold') {
      lot.holds.push({ eventId: e.id, auto: true, reason: e.payload?.reason ?? 'auto out-of-tolerance' });
      return { change: 'none', note: 'auto hold recorded (already on hold)' };
    }
    // quality === 'released'
    const r = lot.lastRelease;
    if (r && isAncestor(r, e.id)) {
      throw new ValidationError(`out-of-tolerance ${e.id} reported after release ${r} (happens-after)`);
    }
    pushHold(lot, e, true);
    if (r) {
      lot.overridden.push({ event: r, by: e.id });
      lot.lastRelease = null;
      return { change: 'auto-override', note: `auto hold overrides release ${r} (concurrent or causally prior)` };
    }
    return { change: 'auto-hold', note: 'auto hold' };
  }

  function transition(lot, e) {
    switch (e.kind) {
      case 'quality.check': {
        const result = e.payload?.result;
        if (result !== 'pass' && result !== 'fail') throw new ValidationError(`quality.check ${e.id} requires payload.result pass|fail`);
        if (result === 'pass') return { change: 'none', note: 'check passed' };
        return autoHold(lot, e);
      }
      case 'quality.hold': {
        if (e.payload?.auto === true) return autoHold(lot, e);
        if (lot.quality !== 'ok') throw new ValidationError(`cannot hold ${e.id}: quality is ${lot.quality}`);
        pushHold(lot, e, false);
        return { change: 'hold', note: 'manual hold' };
      }
      case 'quality.release': {
        if (lot.quality === 'ok') throw new ValidationError(`release ${e.id} without hold`);
        if (lot.quality === 'released') throw new ValidationError(`release ${e.id}: already released`);
        const h = currentHold(lot);
        if (h && h.auto && !isAncestor(h.eventId, e.id)) {
          lot.overridden.push({ event: e.id, by: h.eventId });
          return { change: 'none', note: `release overridden by concurrent auto hold ${h.eventId}`, overridden: true };
        }
        lot.quality = 'released';
        lot.holds = [];
        lot.lastRelease = e.id;
        return { change: 'release', note: 'manual release' };
      }
      case 'device.alarm': {
        const d = lot.devices[e.device];
        if (d && d.status === 'alarming') throw new ValidationError(`alarm ${e.id}: device ${e.device} already alarming`);
        lot.devices[e.device] = { status: 'alarming', event: e.id, code: e.payload?.code ?? null };
        return { change: 'alarm', note: `alarm on ${e.device}` };
      }
      case 'device.clear': {
        const d = lot.devices[e.device];
        if (!d || d.status !== 'alarming') throw new ValidationError(`clear ${e.id}: device ${e.device} not alarming`);
        lot.devices[e.device] = { status: 'clear', event: e.id };
        return { change: 'clear', note: `clear on ${e.device}` };
      }
      default:
        throw new ValidationError(`unknown kind ${e.kind}`);
    }
  }

  function record(e, decision, extra = {}) {
    const rec = { seq: ++seq, id: e.id, lot: e.lot, kind: e.kind, decision, ...extra };
    audit.push(rec);
    return rec;
  }

  function processEvent(e) {
    if (appliedSet.has(e.id)) return record(e, 'duplicate');
    if (pending.some((p) => p.event.id === e.id)) return record(e, 'pending', { reason: 'already-pending' });
    if (rejectedSet.has(e.id)) return record(e, 'rejected', { error: 'previously rejected' });
    const parents = Array.isArray(e.parents) ? e.parents : [];
    known.set(e.id, parents);
    const anc = analyzeAncestors(e.id);
    if (anc.cycle) {
      pending.push({ event: e, reason: 'causal-cycle', missing: [] });
      return record(e, 'pending', { reason: 'causal-cycle' });
    }
    if (anc.unknown.length) {
      pending.push({ event: e, reason: 'unknown-ancestor', missing: anc.unknown });
      return record(e, 'pending', { reason: 'unknown-ancestor', missing: anc.unknown });
    }
    const late = watermark !== null && e.ts < watermark - windowMs;
    const lot = lots.get(e.lot) ?? newLot(e.lot);
    let outcome;
    try {
      outcome = transition(lot, e);
    } catch (err) {
      if (err instanceof ValidationError) {
        rejected.push({ id: e.id, error: err.message });
        rejectedSet.add(e.id);
        return record(e, 'rejected', { error: err.message });
      }
      throw err;
    }
    lot.applied.push(e.id);
    lot.history.push({ id: e.id, kind: e.kind, change: outcome.change, note: outcome.note });
    refreshLocks(lot);
    lots.set(e.lot, lot);
    appliedSet.add(e.id);
    applied.push(e.id);
    watermark = watermark === null ? e.ts : Math.max(watermark, e.ts);
    return record(e, outcome.overridden ? 'overridden' : 'applied', { late, change: outcome.change, note: outcome.note });
  }

  function retryPending() {
    const records = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        const anc = analyzeAncestors(p.event.id);
        if (anc.cycle || anc.unknown.length) {
          p.reason = anc.cycle ? 'causal-cycle' : 'unknown-ancestor';
          p.missing = anc.unknown;
          continue;
        }
        pending.splice(i, 1);
        i--;
        records.push(processEvent(p.event));
        progress = true;
      }
    }
    return records;
  }

  function ingestBatch(events) {
    const report = emptyReport();
    report.received = events.length;
    const valid = [];
    for (const e of events) {
      const err = validateEvent(e);
      if (err) report.malformed.push({ event: e, error: err });
      else valid.push(e);
    }
    const seen = new Set();
    const fresh = [];
    for (const e of valid) {
      if (seen.has(e.id) || appliedSet.has(e.id) || rejectedSet.has(e.id) || pending.some((p) => p.event.id === e.id)) {
        report.duplicates.push(e.id);
        continue;
      }
      seen.add(e.id);
      fresh.push(e);
    }
    fresh.sort(compareEvents);
    for (const e of fresh) collectRecord(report, processEvent(e));
    for (const rec of retryPending()) collectRecord(report, rec);
    return report;
  }

  function hydrate({ lots: lotsObj = {}, pending: pend = [], rejected: rej = [], eventsById = new Map(), loggedOrder = [] } = {}) {
    for (const [name, lot] of Object.entries(lotsObj)) lots.set(name, lot);
    const appliedTruth = new Set();
    for (const lot of lots.values()) for (const id of lot.applied) appliedTruth.add(id);
    for (const id of loggedOrder) if (appliedTruth.has(id)) { applied.push(id); appliedSet.add(id); }
    for (const id of appliedTruth) if (!appliedSet.has(id)) { applied.push(id); appliedSet.add(id); }
    for (const r of rej) { rejected.push(r); rejectedSet.add(r.id); }
    for (const p of pend) pending.push(p);
    for (const [id, e] of eventsById) known.set(id, Array.isArray(e.parents) ? e.parents : []);
    for (const p of pending) known.set(p.event.id, Array.isArray(p.event.parents) ? p.event.parents : []);
    let wm = null;
    for (const id of applied) {
      const e = eventsById.get(id);
      if (e) wm = wm === null ? e.ts : Math.max(wm, e.ts);
    }
    watermark = wm;
    seq = applied.length + rejected.length + pending.length;
  }

  function cert(lotName) {
    const lot = lots.get(lotName);
    const pend = pending
      .filter((p) => p.event.lot === lotName)
      .map((p) => ({ id: p.event.id, reason: p.reason, missing: p.missing }));
    if (!lot && pend.length === 0) return null;
    if (!lot) {
      return { lot: lotName, status: 'pending', pending: pend, explanation: `lot ${lotName} has ${pend.length} pending event(s); no state committed yet` };
    }
    const locked = lot.locks.length > 0;
    const status = pend.length > 0 ? 'pending' : locked ? 'locked' : 'normal';
    const parts = [];
    for (const l of lot.locks) {
      if (l.type === 'quality-hold') parts.push(`quality hold (${l.auto ? 'auto out-of-tolerance' : 'manual'}: ${l.reason}, event ${l.event})`);
      else parts.push(`device ${l.device} alarming (event ${l.event}${l.code ? ', code ' + l.code : ''})`);
    }
    for (const o of lot.overridden) parts.push(`event ${o.event} overridden by ${o.by}`);
    const explanation = locked
      ? `lot ${lotName} is LOCKED: ${parts.join('; ')}`
      : `lot ${lotName} is ${status}${parts.length ? ': ' + parts.join('; ') : ''}`;
    return {
      lot: lotName,
      status,
      quality: lot.quality,
      devices: lot.devices,
      locks: lot.locks,
      holds: lot.holds,
      overridden: lot.overridden,
      history: lot.history,
      applied: lot.applied,
      pending: pend,
      explanation,
    };
  }

  function debugState() {
    const normLot = (lot) => ({
      quality: lot.quality,
      devices: Object.fromEntries(Object.entries(lot.devices).map(([d, i]) => [d, i.status])),
      holds: lot.holds.map((h) => `${h.eventId}:${h.auto}`),
      overridden: lot.overridden.map((o) => `${o.event}>${o.by}`).sort(),
      applied: [...lot.applied].sort(),
      lastRelease: lot.lastRelease,
    });
    return {
      lots: Object.fromEntries([...lots.entries()].map(([k, v]) => [k, normLot(v)])),
      applied: [...applied].sort(),
      rejected: rejected.map((r) => r.id).sort(),
      pending: pending.map((p) => p.event.id).sort(),
      late: audit.filter((r) => r.late).map((r) => r.id).sort(),
      watermark,
    };
  }

  return {
    processEvent,
    ingestBatch,
    retryPending,
    cert,
    hydrate,
    debugState,
    isSettled: (id) => appliedSet.has(id) || rejectedSet.has(id) || pending.some((p) => p.event.id === id),
    get appliedIds() { return [...applied]; },
    get watermark() { return watermark; },
    get lotsObject() { return Object.fromEntries(lots); },
    get pendingList() { return pending; },
    get rejectedList() { return rejected; },
    get auditTrail() { return audit; },
  };
}
