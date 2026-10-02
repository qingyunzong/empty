export const WINDOW_MS = 15 * 60 * 1000;
export const LATENESS_MS = 60 * 1000;
const EPS = 1e-9;

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

export function parseTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  throw new AuditError('BAD_TS', `invalid timestamp: ${JSON.stringify(value)}`);
}

export function windowStartOf(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}

function need(cond, code, msg) {
  if (!cond) throw new AuditError(code, msg);
}

export class Engine {
  constructor() {
    this.meters = new Map();   // meter -> Map<tsMs, {kwh, estimated}>
    this.tariffs = new Map();  // name -> {name, start, end, rate, eventTs}
    this.sheds = new Map();    // `${load}@${ts}` -> {id, load, kw, ts, retracted}
    this.comp = [];            // compensation / correction journal
    this.late = [];            // late events (eventTs < watermark at apply time)
    this.maxEventTs = null;
    this.corrections = 0;
  }

  get watermark() {
    return this.maxEventTs === null ? null : this.maxEventTs - LATENESS_MS;
  }

  apply(event) {
    need(event && typeof event === 'object', 'BAD_INPUT', 'event must be an object');
    const ts = parseTs(event.eventTs);
    if (this.maxEventTs === null || ts > this.maxEventTs) this.maxEventTs = ts;
    if (ts < this.watermark) {
      this.late.push({
        eventTs: iso(ts),
        watermark: iso(this.watermark),
        type: event.type,
        reason: 'event time below watermark (maxEventTs - 60s); applied as incremental correction',
        event,
      });
    }
    switch (event.type) {
      case 'meter': return this.applyMeter(event, ts);
      case 'tariff': return this.applyTariff(event, ts);
      case 'shed': return this.applyShed(event, ts);
      case 'retract': return this.applyRetract(event, ts);
      default:
        throw new AuditError('BAD_INPUT', `unknown event type: ${JSON.stringify(event.type)}`);
    }
  }

  applyMeter(event, ts) {
    const meter = event.meter;
    const kwh = event.kwh;
    need(typeof meter === 'string' && meter.length > 0, 'BAD_INPUT', 'meter event requires meter name');
    need(typeof kwh === 'number' && Number.isFinite(kwh), 'BAD_INPUT', `meter ${meter}: kwh must be a finite number`);
    const op = event.op ?? 'upsert';
    if (op === 'retract') return this.retractMeter(meter, ts, ts);
    need(op === 'upsert', 'BAD_INPUT', `meter ${meter}: unsupported op ${JSON.stringify(event.op)}`);
    if (kwh < 0) {
      throw new AuditError('METER_ROLLBACK', `meter ${meter}: negative cumulative kwh ${kwh} at ${iso(ts)}`);
    }
    let map = this.meters.get(meter);
    if (!map) {
      map = new Map();
      this.meters.set(meter, map);
    }
    const replaced = map.has(ts) ? map.get(ts) : null;
    if (replaced) map.delete(ts);
    // rollback check against active neighbours (corrections replace, they do not roll back)
    let pred = null;
    let succ = null;
    for (const [t, r] of map) {
      if (t < ts && (!pred || t > pred.t)) pred = { t, ...r };
      if (t > ts && (!succ || t < succ.t)) succ = { t, ...r };
    }
    if (pred && pred.kwh > kwh + EPS) {
      if (replaced) map.set(ts, replaced);
      throw new AuditError('METER_ROLLBACK',
        `meter ${meter}: kwh ${kwh} at ${iso(ts)} is below previous reading ${pred.kwh} at ${iso(pred.t)} (not a retract)`);
    }
    if (succ && succ.kwh + EPS < kwh) {
      if (replaced) map.set(ts, replaced);
      throw new AuditError('METER_ROLLBACK',
        `meter ${meter}: kwh ${kwh} at ${iso(ts)} exceeds next reading ${succ.kwh} at ${iso(succ.t)} (not a retract)`);
    }
    map.set(ts, { kwh, estimated: Boolean(event.estimated) });
    if (replaced) {
      this.corrections += 1;
      this.comp.push({
        type: 'meter_correction',
        meter,
        eventTs: iso(ts),
        from: replaced,
        to: { kwh, estimated: Boolean(event.estimated) },
        note: 'reading replaced in place; window energy corrected incrementally',
      });
    }
  }

  retractMeter(meter, readingTs, retractTs) {
    const map = this.meters.get(meter);
    need(map && map.has(readingTs), 'BAD_INPUT',
      `retract: no reading for meter ${meter} at ${iso(readingTs)}`);
    const removed = map.get(readingTs);
    map.delete(readingTs);
    this.corrections += 1;
    this.comp.push({
      type: 'meter_retract',
      meter,
      eventTs: iso(readingTs),
      retracted: removed,
      retractTs: iso(retractTs),
      note: 'reading withdrawn; window energy corrected incrementally',
    });
  }

  applyTariff(event, ts) {
    const name = event.name;
    need(typeof name === 'string' && name.length > 0, 'BAD_INPUT', 'tariff event requires name');
    const op = event.op ?? 'upsert';
    if (op === 'retract') return this.retractTariff(name, ts);
    need(op === 'upsert', 'BAD_INPUT', `tariff ${name}: unsupported op ${JSON.stringify(event.op)}`);
    const start = parseTs(event.start);
    const end = parseTs(event.end);
    const rate = event.rate;
    need(start < end, 'BAD_INPUT', `tariff ${name}: start must be before end`);
    need(typeof rate === 'number' && Number.isFinite(rate) && rate >= 0, 'BAD_INPUT',
      `tariff ${name}: rate must be a non-negative number`);
    this.tariffs.set(name, { name, start, end, rate, eventTs: ts });
  }

  retractTariff(name, retractTs) {
    need(this.tariffs.has(name), 'BAD_INPUT', `retract: unknown tariff ${name}`);
    const removed = this.tariffs.get(name);
    this.tariffs.delete(name);
    this.comp.push({
      type: 'tariff_retract',
      name,
      retracted: { start: iso(removed.start), end: iso(removed.end), rate: removed.rate },
      retractTs: iso(retractTs),
      note: 'rate withdrawn; costs recomputed, physical shed unchanged',
    });
  }

  applyShed(event, ts) {
    const load = event.load;
    const kw = event.kw;
    need(typeof load === 'string' && load.length > 0, 'BAD_INPUT', 'shed event requires load name');
    need(typeof kw === 'number' && Number.isFinite(kw) && kw >= 0, 'BAD_INPUT',
      `shed ${load}: kw must be a non-negative number`);
    const id = `${load}@${ts}`;
    const op = event.op ?? 'upsert';
    if (op === 'retract') return this.retractShed(id, ts);
    need(op === 'upsert', 'BAD_INPUT', `shed ${load}: unsupported op ${JSON.stringify(event.op)}`);
    this.sheds.set(id, { id, load, kw, ts, retracted: false });
  }

  retractShed(id, retractTs) {
    const shed = this.sheds.get(id);
    need(shed, 'BAD_INPUT', `retract: unknown shed ${id}`);
    if (shed.retracted) return;
    shed.retracted = true;
    // Physically executed shed can never be erased; only a compensation record is appended.
    this.comp.push({
      type: 'shed_compensation',
      id,
      load: shed.load,
      kw: shed.kw,
      windowStart: iso(windowStartOf(shed.ts)),
      retractTs: iso(retractTs),
      note: 'shed already executed; retraction recorded as appended compensation, physical record kept',
    });
  }

  applyRetract(event, ts) {
    const kind = event.kind;
    const id = event.id;
    need(typeof id === 'string' && id.length > 0, 'BAD_INPUT', 'retract event requires id');
    if (kind === 'meter') {
      const at = id.lastIndexOf('@');
      need(at > 0, 'BAD_INPUT', `meter retract id must be "<meter>@<ts>", got ${id}`);
      return this.retractMeter(id.slice(0, at), parseTs(id.slice(at + 1)), ts);
    }
    if (kind === 'tariff') return this.retractTariff(id, ts);
    if (kind === 'shed') return this.retractShed(id, ts);
    throw new AuditError('BAD_INPUT', `unknown retract kind: ${JSON.stringify(kind)}`);
  }

  rateFor(windowStartMs) {
    let best = null;
    for (const t of this.tariffs.values()) {
      if (t.start <= windowStartMs && windowStartMs < t.end) {
        if (!best || t.eventTs >= best.eventTs) best = t;
      }
    }
    return best;
  }

  finalize() {
    const windows = new Map(); // ws -> record
    const rec = (ws) => {
      let w = windows.get(ws);
      if (!w) {
        w = { ws, kwh: 0, estimated: false, shedCaps: new Map() };
        windows.set(ws, w);
      }
      return w;
    };
    for (const map of this.meters.values()) {
      const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < entries.length; i += 1) {
        const diff = entries[i][1].kwh - entries[i - 1][1].kwh;
        // A cumulative reading closes the interval since the previous reading;
        // attribute energy to the window containing (readingTs - 1ms) so a
        // reading exactly on a boundary closes the window it ends.
        if (diff > EPS) rec(windowStartOf(entries[i][0] - 1)).kwh += diff;
      }
      for (const [t, r] of entries) {
        if (r.estimated) rec(windowStartOf(t - 1)).estimated = true;
      }
    }
    for (const s of this.sheds.values()) {
      const w = rec(windowStartOf(s.ts));
      w.shedCaps.set(s.load, (w.shedCaps.get(s.load) ?? 0) + s.kw);
    }
    const out = [];
    for (const w of [...windows.values()].sort((a, b) => a.ws - b.ws)) {
      const tariff = this.rateFor(w.ws);
      const shed = [...w.shedCaps.entries()]
        .map(([load, kw]) => ({ load, kw }))
        .sort((a, b) => (a.load < b.load ? -1 : a.load > b.load ? 1 : 0));
      const shedKw = shed.reduce((acc, s) => acc + s.kw, 0);
      const grossKw = w.kwh * 4; // 15-min kWh -> average kW
      const rate = tariff ? tariff.rate : 0;
      out.push({
        windowStart: iso(w.ws),
        windowStartMs: w.ws,
        windowEnd: iso(w.ws + WINDOW_MS),
        kwh: w.kwh,
        grossKw,
        rate,
        rateMissing: !tariff,
        estimated: w.estimated,
        shed,
        shedKw,
        netKw: grossKw - shedKw,
        billed: (grossKw - shedKw) * rate,
      });
    }
    return out;
  }
}
