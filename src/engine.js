import { createHash } from 'node:crypto';
import { findCycles } from './graph.js';

export const DEFAULT_LAG_MS = 2000;

export class AgvError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgvError';
    this.code = code;
  }
}

export function edgeEndpoints(edge) {
  const parts = String(edge).split('->');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new AgvError('BAD_EDGE', `edge must have form "from->to", got ${JSON.stringify(edge)}`);
  }
  return parts;
}

function needString(e, field, lineno) {
  if (typeof e[field] !== 'string' || e[field].length === 0) {
    throw new AgvError('BAD_EVENT', `line ${lineno}: ${e.type} requires non-empty string field "${field}"`);
  }
}

export function parseEvent(line, lineno) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    throw new AgvError('BAD_JSON', `line ${lineno}: invalid JSON`);
  }
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    throw new AgvError('BAD_EVENT', `line ${lineno}: event must be a JSON object`);
  }
  if (typeof e.eventTs !== 'number' || !Number.isFinite(e.eventTs)) {
    throw new AgvError('BAD_EVENT', `line ${lineno}: eventTs must be a finite number (ms)`);
  }
  switch (e.type) {
    case 'reserve':
      needString(e, 'id', lineno);
      needString(e, 'agv', lineno);
      needString(e, 'edge', lineno);
      edgeEndpoints(e.edge);
      if (e.op !== 'start' && e.op !== 'end') {
        throw new AgvError('BAD_EVENT', `line ${lineno}: reserve op must be "start" or "end"`);
      }
      break;
    case 'ping':
      needString(e, 'id', lineno);
      needString(e, 'agv', lineno);
      needString(e, 'node', lineno);
      if (typeof e.speed !== 'number' || !Number.isFinite(e.speed)) {
        throw new AgvError('BAD_EVENT', `line ${lineno}: ping speed must be a finite number`);
      }
      break;
    case 'cancel':
      needString(e, 'reserveId', lineno);
      break;
    case 'retract':
      needString(e, 'id', lineno);
      if (e.kind !== 'reserve' && e.kind !== 'ping' && e.kind !== 'cancel') {
        throw new AgvError('BAD_EVENT', `line ${lineno}: retract kind must be reserve|ping|cancel`);
      }
      break;
    default:
      throw new AgvError('BAD_EVENT', `line ${lineno}: unknown event type ${JSON.stringify(e.type)}`);
  }
  return e;
}

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function makeCert(cycle, edges, start, end) {
  const interval = [start, end === Infinity ? null : end];
  const hash = sha256hex(stableStringify({ cycle, edges, interval }));
  return { hash, cycle, interval, edges };
}

// instances: [{from, to, start, end, reserveId, pingId}] with start < end (end may be Infinity).
// Returns deterministic certificates: one per (cycle, maximal interval run, evidence).
export function computeCertificates(instances) {
  if (instances.length === 0) return [];
  const ptSet = new Set();
  for (const i of instances) {
    ptSet.add(i.start);
    if (i.end !== Infinity) ptSet.add(i.end);
  }
  const pts = [...ptSet].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  if (instances.some((i) => i.end === Infinity)) segs.push([pts[pts.length - 1], Infinity]);

  // Per elementary segment: cycle key -> {cycle, edges}.
  const segMaps = segs.map(([s, t]) => {
    const adj = new Map();
    const evidence = new Map();
    for (const inst of instances) {
      if (inst.start <= s && inst.end >= t) {
        if (!adj.has(inst.from)) adj.set(inst.from, new Set());
        adj.get(inst.from).add(inst.to);
        const ek = `${inst.from} ${inst.to}`;
        const cand = `${inst.reserveId} ${inst.pingId}`;
        const cur = evidence.get(ek);
        if (!cur || cand < cur.cand) {
          evidence.set(ek, { cand, reserveId: inst.reserveId, pingId: inst.pingId });
        }
      }
    }
    const adjList = new Map([...adj].map(([k, v]) => [k, [...v]]));
    const m = new Map();
    for (const cycle of findCycles(adjList)) {
      const edges = cycle.map((from, i) => {
        const to = cycle[(i + 1) % cycle.length];
        const ev = evidence.get(`${from} ${to}`);
        return { from, to, reserveId: ev.reserveId, pingId: ev.pingId };
      });
      m.set(stableStringify({ cycle, edges }), { cycle, edges });
    }
    return m;
  });

  // Merge consecutive segments with identical cycle sets into maximal runs.
  const certs = [];
  let runMap = null;
  let runKeys = null;
  let runStart = null;
  let prevEnd = null;
  const closeRun = (end) => {
    for (const { cycle, edges } of runMap.values()) certs.push(makeCert(cycle, edges, runStart, end));
  };
  for (let i = 0; i < segs.length; i++) {
    const keys = [...segMaps[i].keys()].sort().join('|');
    if (runMap !== null && keys === runKeys) {
      // extend current run
    } else {
      if (runMap !== null) closeRun(prevEnd);
      runMap = segMaps[i];
      runKeys = keys;
      runStart = segs[i][0];
    }
    prevEnd = segs[i][1];
  }
  if (runMap !== null) closeRun(prevEnd);

  certs.sort((a, b) => a.interval[0] - b.interval[0] || (a.hash < b.hash ? -1 : 1));
  return certs;
}

export class Engine {
  constructor({ lagMs = DEFAULT_LAG_MS } = {}) {
    this.lagMs = lagMs;
    this.events = [];
    this.seq = 0;
    this.maxTs = -Infinity;
    this.late = [];
    this.emitted = [];
    this.invalidated = [];
    this.active = new Map();
    this.knownAgvs = new Set();
    this.liveReserveStarts = new Set();
    this.waits = [];
  }

  get watermark() {
    return this.maxTs - this.lagMs;
  }

  ingest(e) {
    this.seq += 1;
    const event = { ...e, seq: this.seq };

    if (event.type === 'reserve' && event.op === 'start') {
      if (this.liveReserveStarts.has(event.id)) {
        throw new AgvError('DUP_RESERVE', `duplicate reserveId ${JSON.stringify(event.id)}`);
      }
    }
    if (event.type === 'ping' && !this.knownAgvs.has(event.agv)) {
      throw new AgvError('UNKNOWN_AGV', `ping references unknown agv ${JSON.stringify(event.agv)}`);
    }

    if (event.type === 'reserve' && event.op === 'start') {
      this.liveReserveStarts.add(event.id);
      this.knownAgvs.add(event.agv);
    }
    if (event.type === 'retract' && event.kind === 'reserve') {
      this.liveReserveStarts.delete(event.id);
    }

    this.events.push(event);
    if (event.eventTs > this.maxTs) this.maxTs = event.eventTs;
    if (event.eventTs < this.watermark) {
      const id = event.id ?? event.reserveId ?? '-';
      this.late.push(
        `LATE seq=${event.seq} type=${event.type} id=${id} eventTs=${event.eventTs} watermark=${this.watermark}`
      );
    }
    this.#recompute();
  }

  #recompute() {
    const retracted = new Set();
    for (const e of this.events) {
      if (e.type === 'retract') retracted.add(`${e.kind}:${e.id}`);
    }
    const keyOf = (e) =>
      e.type === 'cancel' ? `cancel:${e.id ?? e.reserveId}` : `${e.type}:${e.id}`;
    const live = this.events.filter((e) => e.type !== 'retract' && !retracted.has(keyOf(e)));

    // Reserve occupancy windows from start/end pairs, paired in event-time order.
    const reservesById = new Map();
    for (const e of live) {
      if (e.type !== 'reserve') continue;
      if (!reservesById.has(e.id)) reservesById.set(e.id, []);
      reservesById.get(e.id).push(e);
    }
    let windows = [];
    for (const [id, list] of reservesById) {
      list.sort((a, b) => a.eventTs - b.eventTs || a.seq - b.seq);
      let cur = null;
      for (const e of list) {
        if (e.op === 'start') {
          if (cur) windows.push({ ...cur, end: e.eventTs });
          cur = { reserveId: id, agv: e.agv, edge: e.edge, start: e.eventTs, end: Infinity };
        } else if (cur) {
          windows.push({ ...cur, end: e.eventTs });
          cur = null;
        }
      }
      if (cur) windows.push(cur);
    }
    // Cancels truncate windows at their event time (may rewrite history when late).
    for (const e of live) {
      if (e.type !== 'cancel') continue;
      for (const w of windows) {
        if (w.reserveId === e.reserveId) w.end = Math.min(w.end, e.eventTs);
      }
    }
    windows = windows.filter((w) => w.end > w.start);

    // Ping presence windows: valid until the same agv's next ping (event-time order).
    const pingsByAgv = new Map();
    for (const e of live) {
      if (e.type !== 'ping') continue;
      if (!pingsByAgv.has(e.agv)) pingsByAgv.set(e.agv, []);
      pingsByAgv.get(e.agv).push(e);
    }
    const pingWins = [];
    for (const [agv, list] of pingsByAgv) {
      list.sort((a, b) => a.eventTs - b.eventTs || a.seq - b.seq);
      for (let i = 0; i < list.length; i++) {
        pingWins.push({
          pingId: list[i].id,
          agv,
          node: list[i].node,
          speed: list[i].speed,
          start: list[i].eventTs,
          end: i + 1 < list.length ? list[i + 1].eventTs : Infinity,
        });
      }
    }

    // Window join: stopped ping at node N x reserve on edge incident to N.
    // Wait edge points from the waiter (reserving agv) to the blocker (stopped agv).
    // Strict overlap only: touching endpoints do not constitute waiting.
    const instances = [];
    for (const p of pingWins) {
      if (p.speed > 0) continue;
      for (const w of windows) {
        if (w.agv === p.agv) continue;
        if (!edgeEndpoints(w.edge).includes(p.node)) continue;
        const s = Math.max(p.start, w.start);
        const t = Math.min(p.end, w.end);
        if (s < t) {
          instances.push({
            from: w.agv,
            to: p.agv,
            start: s,
            end: t,
            reserveId: w.reserveId,
            pingId: p.pingId,
          });
        }
      }
    }
    instances.sort(
      (a, b) =>
        (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
        (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
        a.start - b.start ||
        (a.reserveId < b.reserveId ? -1 : a.reserveId > b.reserveId ? 1 : 0) ||
        (a.pingId < b.pingId ? -1 : a.pingId > b.pingId ? 1 : 0)
    );
    this.waits = instances;

    const certs = computeCertificates(instances);
    const next = new Map(certs.map((c) => [c.hash, c]));
    for (const [hash, cert] of next) {
      if (!this.active.has(hash)) this.emitted.push({ ...cert, detectedSeq: this.seq });
    }
    for (const [hash, cert] of this.active) {
      if (!next.has(hash)) {
        this.invalidated.push({
          hash,
          invalidated: true,
          seq: this.seq,
          cycle: cert.cycle,
          interval: cert.interval,
        });
      }
    }
    this.active = next;
  }
}
