import { optimizeShed } from './optimize.js';

export const WINDOW_MS = 15 * 60 * 1000;
export const LATE_GRACE_MS = 60 * 1000;

const EPS = 1e-9;

export class AuditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.details = details;
  }
}

function parseTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseLine(line, lineno) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { error: { reason: 'bad_json', line: lineno } };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: { reason: 'bad_shape', line: lineno } };
  }
  const eventTs = parseTs(obj.eventTs);
  if (eventTs === null) return { error: { reason: 'bad_eventTs', line: lineno } };
  const base = {
    id: obj.id != null ? String(obj.id) : null,
    eventTs,
    op: obj.op === 'retract' ? 'retract' : 'upsert',
  };
  switch (obj.type) {
    case 'meter': {
      const kwh = num(obj.kwh);
      if (kwh === null) return { error: { reason: 'bad_kwh', line: lineno } };
      if (typeof obj.meter !== 'string' || obj.meter === '') {
        return { error: { reason: 'bad_meter', line: lineno } };
      }
      return { event: { ...base, type: 'meter', meter: obj.meter, kwh, estimated: obj.estimated === true } };
    }
    case 'tariff': {
      const start = parseTs(obj.start);
      const end = parseTs(obj.end);
      const rate = num(obj.rate);
      if (start === null || end === null || end <= start) {
        return { error: { reason: 'bad_window', line: lineno } };
      }
      if (rate === null || rate < 0) return { error: { reason: 'bad_rate', line: lineno } };
      if (typeof obj.name !== 'string' || obj.name === '') {
        return { error: { reason: 'bad_name', line: lineno } };
      }
      return { event: { ...base, type: 'tariff', name: obj.name, start, end, rate } };
    }
    case 'shed': {
      const kw = num(obj.kw);
      if (kw === null || kw <= 0) return { error: { reason: 'bad_kw', line: lineno } };
      if (typeof obj.load !== 'string' || obj.load === '') {
        return { error: { reason: 'bad_load', line: lineno } };
      }
      return { event: { ...base, type: 'shed', load: obj.load, kw } };
    }
    case 'retract': {
      if (!['meter', 'tariff', 'shed'].includes(obj.kind)) {
        return { error: { reason: 'bad_kind', line: lineno } };
      }
      if (obj.id == null) return { error: { reason: 'bad_id', line: lineno } };
      return { event: { ...base, type: 'retract', kind: obj.kind, refId: String(obj.id) } };
    }
    default:
      return { error: { reason: 'bad_type', line: lineno } };
  }
}

function retractEvent(kind, id, eventTs, tables, comp, late) {
  if (id == null || !tables[kind].has(id)) {
    late.push({ reason: 'unknown_retract', kind, id: id ?? null, eventTs });
    return;
  }
  if (kind === 'shed') {
    // An executed load shed is a physical fact: it cannot be rewritten to
    // "never happened". Keep it and append a compensation record instead.
    const shed = tables.shed.get(id);
    comp.push({
      eventTs,
      kind: 'shed',
      id,
      load: shed.load,
      kw: shed.kw,
      action: 'compensate',
      reason: 'SHED_RETRACT_FORBIDDEN',
    });
    return;
  }
  tables[kind].delete(id);
}

function applyEvent(event, seq, tables, comp, late) {
  if (event.type === 'retract') {
    retractEvent(event.kind, event.refId, event.eventTs, tables, comp, late);
    return;
  }
  if (event.op === 'retract') {
    retractEvent(event.type, event.id, event.eventTs, tables, comp, late);
    return;
  }
  const id = event.id ?? `${event.type}#${seq}`;
  tables[event.type].set(id, { ...event, id, seq });
}

function windowStartOf(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

function getWindow(windows, windowStart) {
  let w = windows.get(windowStart);
  if (!w) {
    w = { windowStart, kwh: 0, estimated: false, sheds: [] };
    windows.set(windowStart, w);
  }
  return w;
}

function computeMeterWindows(tables, windows) {
  const byMeter = new Map();
  for (const r of tables.meter.values()) {
    if (!byMeter.has(r.meter)) byMeter.set(r.meter, []);
    byMeter.get(r.meter).push(r);
  }
  for (const [meter, list] of byMeter) {
    list.sort((a, b) => a.eventTs - b.eventTs || a.seq - b.seq);
    let prev = 0; // cumulative meters start from a zero baseline
    let first = true;
    for (const r of list) {
      const delta = r.kwh - prev;
      if (delta < -EPS) {
        throw new AuditError(
          'METER_ROLLBACK',
          `meter ${meter} kwh rolled back from ${prev} to ${r.kwh} (id ${r.id}) without retraction`,
          { meter, id: r.id, prev, kwh: r.kwh },
        );
      }
      if (!first && (delta > EPS || r.estimated)) {
        // Energy consumed in (prevTs, ts] is attributed to the window that
        // ends at (or contains) the later reading.
        const w = getWindow(windows, windowStartOf(r.eventTs - 1));
        w.kwh += Math.max(delta, 0);
        if (r.estimated) w.estimated = true;
      }
      first = false;
      prev = r.kwh;
    }
  }
}

function joinTariff(tariffs, windowStart, windowEnd) {
  let best = null;
  for (const t of tariffs) {
    if (t.start <= windowStart && t.end >= windowEnd) {
      if (!best || t.eventTs > best.eventTs || (t.eventTs === best.eventTs && t.seq > best.seq)) {
        best = t;
      }
    }
  }
  return best;
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

export function runAudit(lines, opts = {}) {
  const budget = opts.budget ?? Infinity;
  const late = [];
  const comp = [];
  const tables = { meter: new Map(), tariff: new Map(), shed: new Map() };
  let maxEventTs = -Infinity;
  let watermark = -Infinity;
  let seq = 0;

  for (const raw of lines) {
    seq += 1;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const { event, error } = parseLine(raw, seq);
    if (error) {
      late.push(error);
      continue;
    }
    if (event.eventTs < watermark) {
      late.push({ reason: 'late', line: seq, eventTs: iso(event.eventTs), watermark: iso(watermark) });
    }
    if (event.eventTs > maxEventTs) {
      maxEventTs = event.eventTs;
      watermark = maxEventTs - LATE_GRACE_MS;
    }
    applyEvent(event, seq, tables, comp, late);
  }

  const windows = new Map();
  computeMeterWindows(tables, windows);
  for (const s of tables.shed.values()) {
    const w = getWindow(windows, windowStartOf(s.eventTs));
    w.sheds.push({ load: s.load, kw: s.kw });
  }

  const tariffs = [...tables.tariff.values()];
  const sortedStarts = [...windows.keys()].sort((a, b) => a - b);
  const windowRows = [];
  const optWindows = [];
  for (const ws of sortedStarts) {
    const w = windows.get(ws);
    const we = ws + WINDOW_MS;
    const tariff = joinTariff(tariffs, ws, we);
    const rate = tariff ? tariff.rate : 0;
    w.sheds.sort((a, b) => (a.load < b.load ? -1 : a.load > b.load ? 1 : 0));
    const shedKw = w.sheds.reduce((acc, s) => acc + s.kw, 0);
    const demandKw = w.kwh * (3600000 / WINDOW_MS);
    const baselineKw = demandKw + shedKw;
    windowRows.push({
      windowStart: iso(ws),
      windowEnd: iso(we),
      kwh: round6(w.kwh),
      demandKw: round6(demandKw),
      shedKw: round6(shedKw),
      baselineKw: round6(baselineKw),
      rate,
      tariff: tariff ? tariff.name : null,
      estimated: w.estimated,
      final: we <= watermark,
      sheds: w.sheds.map((s) => ({ load: s.load, kw: s.kw })),
    });
    optWindows.push({ windowStart: ws, baselineKw, rate });
  }

  // Candidate sheddable loads come from executed shed events (physical facts).
  const loadKw = new Map();
  for (const s of tables.shed.values()) {
    loadKw.set(s.load, Math.max(loadKw.get(s.load) ?? 0, s.kw));
  }
  const loads = [...loadKw.entries()]
    .map(([load, kw]) => ({ load, kw }))
    .sort((a, b) => (a.load < b.load ? -1 : 1));

  const optimal = optimizeShed(optWindows, loads, budget);

  const isoPlans = optimal.plans.map((plan) => {
    const actions = [];
    for (const p of plan) {
      for (const load of p.loads) {
        actions.push({ windowStart: iso(p.windowStart), load, kw: loadKw.get(load) });
      }
    }
    actions.sort((a, b) =>
      a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : a.load < b.load ? -1 : 1,
    );
    return actions;
  });

  let executedCost = 0;
  let executedShedKw = 0;
  const executedPlan = [];
  let peak = null;
  for (let i = 0; i < windowRows.length; i++) {
    const row = windowRows[i];
    const cost = row.demandKw * row.rate;
    if (cost > executedCost) executedCost = cost;
    executedShedKw += row.shedKw;
    for (const s of row.sheds) executedPlan.push({ windowStart: row.windowStart, load: s.load, kw: s.kw });
    if (!peak || cost > peak.cost + EPS) {
      peak = { windowStart: row.windowStart, demandKw: row.demandKw, rate: row.rate, cost: round6(cost) };
    }
  }
  executedPlan.sort((a, b) =>
    a.windowStart < b.windowStart ? -1 : a.windowStart > b.windowStart ? 1 : a.load < b.load ? -1 : 1,
  );

  const settlement = {
    watermark: maxEventTs === -Infinity ? null : iso(watermark),
    windowMs: WINDOW_MS,
    lateGraceMs: LATE_GRACE_MS,
    windowCount: windowRows.length,
    budgetKw: budget === Infinity ? null : budget,
    peak,
    optimal: {
      method: optimal.method,
      cost: round6(optimal.cost),
      totalShedKw: round6(optimal.totalShedKw),
      planCount: isoPlans.length,
      truncated: optimal.truncated,
      plans: isoPlans,
    },
    executed: {
      cost: round6(executedCost),
      totalShedKw: round6(executedShedKw),
      plan: executedPlan,
    },
    executedIsOptimal: executedCost <= optimal.cost + EPS,
    errors: [],
  };

  return { windows: windowRows, settlement, comp, late };
}

export function runAuditText(text, opts = {}) {
  return runAudit(text.split('\n'), opts);
}
