'use strict';

const { createHash } = require('node:crypto');
const { MinHeap } = require('./heap');
const { generateArrivals } = require('./arrivals');

class SimError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SimError';
    this.code = code;
  }
}

// Event rank at equal timestamps: completions free capacity before
// new arrivals claim it. `seq` (insertion order) is the final,
// stable tie-break for every event class.
const RANK = { complete: 0, arrival: 1, injected: 2 };

function cmpEvent(x, y) {
  return x.time - y.time || x.rank - y.rank || x.seq - y.seq;
}

function validateDomain(stations, buffers, policy) {
  if (!Array.isArray(stations) || stations.length === 0) {
    throw new SimError('ERR_DOMAIN', 'stations must be a non-empty array');
  }
  if (!Array.isArray(buffers) || buffers.length !== stations.length - 1) {
    throw new SimError('ERR_DOMAIN', 'buffers.length must equal stations.length - 1');
  }
  stations.forEach((s, i) => {
    if (!s || !Number.isInteger(s.cap) || s.cap < 0) {
      throw new SimError('ERR_DOMAIN', `station ${i} capacity must be a non-negative integer`);
    }
    if (!Number.isFinite(s.proc) || s.proc < 0) {
      throw new SimError('ERR_DOMAIN', `station ${i} proc must be a non-negative number`);
    }
  });
  buffers.forEach((b, i) => {
    if (!b || !Number.isInteger(b.cap) || b.cap < 0) {
      throw new SimError('ERR_DOMAIN', `buffer ${i} capacity must be a non-negative integer`);
    }
  });
  if (policy !== 'fifo' && policy !== 'priority') {
    throw new SimError('ERR_DOMAIN', `unknown policy: ${policy}`);
  }
}

// Accepts either an explicit array of arrivals or a generator spec
// ({ seed, count, ... }). Returns a list sorted by (time, seq);
// the sort is stable so equal timestamps keep generation order.
function normalizeArrivals(config) {
  let list;
  if (Array.isArray(config.arrivals)) {
    list = config.arrivals.map((a, i) => ({
      id: a.id ?? `J${i}`,
      time: a.time,
      priority: a.priority ?? 0,
      seq: a.seq ?? i,
    }));
  } else if (config.arrivals && typeof config.arrivals === 'object') {
    list = generateArrivals(config.arrivals);
  } else {
    list = [];
  }
  const seen = new Set();
  for (const a of list) {
    if (!Number.isFinite(a.time) || a.time < 0) {
      throw new SimError('ERR_DOMAIN', `invalid arrival time for ${a.id}: ${a.time}`);
    }
    if (seen.has(a.id)) {
      throw new SimError('ERR_DOMAIN', `duplicate arrival id: ${a.id}`);
    }
    seen.add(a.id);
  }
  return list.slice().sort((x, y) => x.time - y.time || x.seq - y.seq);
}

class Engine {
  constructor(config, options = {}) {
    const { stations, buffers, policy = 'fifo' } = config;
    validateDomain(stations, buffers, policy);
    this.policy = policy;
    this.horizon = options.horizon ?? Infinity;
    this.eventHook = options.eventHook ?? null;
    this.keepSnapshots = options.keepSnapshots ?? false;

    this.stations = stations.map((s) => ({ cap: s.cap, proc: s.proc, wip: [], completed: 0 }));
    this.buffers = buffers.map((b) => ({ cap: b.cap, queue: [] }));
    this.jobs = new Map();
    this.queue = new MinHeap(cmpEvent);

    this.clock = 0;
    this.seq = 0;
    this.trace = [];
    this.choicePoints = [];
    this.snapshots = [];
    this.violation = null;
    this.truncated = false;
    this.eventsProcessed = 0;
    this.eventsAtTime = 0;
    this.seenAtTime = new Set();
    this.stateKeys = [];

    const arrivals = normalizeArrivals(config);
    this.maxEventsPerTime =
      options.maxEventsPerTime ?? 64 + 16 * (arrivals.length + 1) * (this.stations.length + 1);
    for (const a of arrivals) {
      this.jobs.set(a.id, { id: a.id, priority: a.priority, seq: a.seq });
      this.schedule(a.time, 'arrival', { jobId: a.id });
    }
  }

  schedule(time, type, data = {}) {
    this.queue.push({ time, rank: RANK[type] ?? RANK.injected, seq: this.seq++, type, ...data });
  }

  log(entry) {
    this.trace.push({ time: this.clock, ...entry });
  }

  stateKey() {
    return JSON.stringify([
      this.stations.map((s) => s.wip),
      this.buffers.map((b) => b.queue),
      this.queue.size,
    ]);
  }

  recordState() {
    this.stateKeys.push(this.stateKey());
  }

  tryStart(i, jobId) {
    const st = this.stations[i];
    if (st.wip.length >= st.cap) return false;
    const doneAt = this.clock + st.proc;
    st.wip.push({ jobId, doneAt });
    this.log({ type: 'start', job: jobId, station: i });
    this.schedule(doneAt, 'complete', { jobId, station: i });
    return true;
  }

  selectIndex(queue) {
    if (this.policy === 'fifo') return 0;
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      const cand = this.jobs.get(queue[i]);
      const cur = this.jobs.get(queue[best]);
      if (cand.priority > cur.priority || (cand.priority === cur.priority && cand.seq < cur.seq)) {
        best = i;
      }
    }
    return best;
  }

  process(ev) {
    if (ev.type === 'arrival') {
      this.log({ type: 'arrival', job: ev.jobId });
      if (!this.tryStart(0, ev.jobId)) {
        this.violation = { time: this.clock, type: 'station-overflow', station: 0, job: ev.jobId };
      }
      return;
    }
    if (ev.type === 'complete') {
      const st = this.stations[ev.station];
      const idx = st.wip.findIndex((w) => w.jobId === ev.jobId);
      if (idx >= 0) st.wip.splice(idx, 1);
      st.completed++;
      this.log({ type: 'complete', job: ev.jobId, station: ev.station });
      const next = ev.station + 1;
      if (next === this.stations.length) {
        this.log({ type: 'depart', job: ev.jobId });
        return;
      }
      if (this.tryStart(next, ev.jobId)) return;
      const buf = this.buffers[ev.station];
      if (buf.queue.length < buf.cap) {
        buf.queue.push(ev.jobId);
        this.log({ type: 'buffer-enter', job: ev.jobId, buffer: ev.station });
      } else {
        this.violation = { time: this.clock, type: 'buffer-overflow', buffer: ev.station, job: ev.jobId };
      }
      return;
    }
    // 'injected' / unknown event types are no-ops.
  }

  dispatch() {
    let changed = true;
    while (changed && !this.violation) {
      changed = false;
      for (let i = 0; i < this.buffers.length; i++) {
        const buf = this.buffers[i];
        const downstream = this.stations[i + 1];
        while (buf.queue.length > 0 && downstream.wip.length < downstream.cap) {
          const idx = this.selectIndex(buf.queue);
          const chosen = buf.queue[idx];
          if (buf.queue.length > 1) {
            this.choicePoints.push({
              eventSeq: this.eventsProcessed,
              traceIndex: this.trace.length,
              buffer: i,
              candidates: buf.queue.slice(),
              chosen,
            });
          }
          buf.queue.splice(idx, 1);
          this.log({ type: 'buffer-exit', job: chosen, buffer: i });
          this.tryStart(i + 1, chosen);
          changed = true;
        }
      }
    }
  }

  // Starvation: a downstream station (i >= 1) that has already produced
  // is idle with free capacity while its upstream buffer is empty and
  // more events are still pending.
  checkStarvation() {
    for (let i = 1; i < this.stations.length; i++) {
      const st = this.stations[i];
      if (st.cap > 0 && st.completed > 0 && st.wip.length < st.cap && this.buffers[i - 1].queue.length === 0) {
        this.violation = { time: this.clock, type: 'starvation', station: i };
        return;
      }
    }
  }

  run() {
    this.recordState();
    while (this.queue.size > 0) {
      if (this.queue.peek().time > this.horizon) {
        this.truncated = true;
        break;
      }
      if (this.keepSnapshots) {
        this.snapshots[this.eventsProcessed] = this.serialize();
      }
      const ev = this.queue.pop();
      if (ev.time !== this.clock) {
        this.clock = ev.time;
        this.eventsAtTime = 0;
        this.seenAtTime = new Set();
      }
      this.eventsAtTime++;
      if (this.eventsAtTime > this.maxEventsPerTime) {
        throw new SimError('ERR_CYCLE', `event loop suspected: more than ${this.maxEventsPerTime} events at t=${this.clock}`);
      }
      const key = this.stateKey();
      if (this.seenAtTime.has(key)) {
        throw new SimError('ERR_CYCLE', `state repeats without time advance at t=${this.clock}`);
      }
      this.seenAtTime.add(key);
      if (this.eventHook) this.eventHook(this, ev);
      this.process(ev);
      if (!this.violation) this.dispatch();
      if (!this.violation && this.queue.size > 0 && this.queue.peek().time > this.clock) {
        this.checkStarvation();
      }
      this.eventsProcessed++;
      this.recordState();
      if (this.violation) break;
    }
    return this;
  }

  serialize() {
    return {
      clock: this.clock,
      seq: this.seq,
      stations: structuredClone(this.stations.map((s) => ({ wip: s.wip, completed: s.completed }))),
      buffers: structuredClone(this.buffers.map((b) => b.queue)),
      queue: structuredClone(this.queue.a),
      traceLen: this.trace.length,
      choiceLen: this.choicePoints.length,
      eventsProcessed: this.eventsProcessed,
      eventsAtTime: this.eventsAtTime,
      seenAtTime: [...this.seenAtTime],
      stateKeysLen: this.stateKeys.length,
    };
  }

  static restore(snap, config, options, oldEngine) {
    const e = new Engine(config, options);
    e.clock = snap.clock;
    e.seq = snap.seq;
    e.stations.forEach((s, i) => {
      s.wip = structuredClone(snap.stations[i].wip);
      s.completed = snap.stations[i].completed;
    });
    e.buffers.forEach((b, i) => {
      b.queue = snap.buffers[i].slice();
    });
    e.queue = new MinHeap(cmpEvent);
    e.queue.a = structuredClone(snap.queue);
    e.trace = oldEngine.trace.slice(0, snap.traceLen);
    e.choicePoints = oldEngine.choicePoints.slice(0, snap.choiceLen);
    e.eventsProcessed = snap.eventsProcessed;
    e.eventsAtTime = snap.eventsAtTime;
    e.seenAtTime = new Set(snap.seenAtTime);
    e.stateKeys = oldEngine.stateKeys.slice(0, snap.stateKeysLen);
    return e;
  }

  certificate() {
    const distinct = new Set(this.stateKeys);
    const digest = createHash('sha256').update(this.stateKeys.join('|')).digest('hex');
    return {
      horizon: this.horizon === Infinity ? null : this.horizon,
      eventsProcessed: this.eventsProcessed,
      statesVisited: this.stateKeys.length,
      distinctStates: distinct.size,
      queueDrained: this.queue.size === 0,
      digest,
    };
  }
}

// Run one simulation to completion (or first violation / horizon).
// Returns { status, trace, firstViolation, certificate }.
// status: 'SAFE' | 'VIOLATION' | 'UNKNOWN'. SAFE is only reported when
// the event queue was fully drained within the horizon, i.e. every
// reachable state in the finite time bound was checked; the certificate
// carries the covered state space. UNKNOWN is never reported as SAFE.
function simulate(config, options = {}) {
  const engine = new Engine(config, options);
  engine.run();
  const base = { trace: engine.trace, certificate: null };
  if (engine.violation) {
    return { ...base, status: 'VIOLATION', firstViolation: engine.violation };
  }
  if (engine.truncated || engine.queue.size > 0) {
    return { ...base, status: 'UNKNOWN', firstViolation: null, reason: 'horizon-exceeded' };
  }
  return { ...base, status: 'SAFE', firstViolation: null, certificate: engine.certificate() };
}

module.exports = { Engine, SimError, simulate, normalizeArrivals, RANK };
