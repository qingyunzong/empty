import { canonical, sha256 } from './canon.js';
import { solveSchedule } from './solver.js';

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

function checkWindow(w, what) {
  if (!Array.isArray(w) || w.length !== 2 || !Number.isFinite(w[0]) || !Number.isFinite(w[1])) {
    throw new DomainError('BAD_WINDOW', `${what}: window must be [start, end] numbers`);
  }
  if (w[1] - w[0] <= 0) {
    throw new DomainError('NEGATIVE_DURATION', `${what}: non-positive duration [${w[0]}, ${w[1]}]`);
  }
}

const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class Store {
  constructor() {
    this.clock = 0;
    this.targets = new Map();
    this.quotas = new Map();
    this.observations = new Map();
    this.evidence = [];
    this.log = [];
    this.onCheckpoint = null;
  }

  // Conflict ordering for concurrent history: (clock, nodeID, targetID).
  static keyOf(e) {
    return [e.clock ?? 0, e.node ?? '', e.target ?? e.obs ?? ''];
  }

  static compare(a, b) {
    const ka = Store.keyOf(a);
    const kb = Store.keyOf(b);
    for (let i = 0; i < 3; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  }

  applyAll(events) {
    for (const e of [...events].sort(Store.compare)) this.apply(e);
  }

  apply(e) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') {
      throw new DomainError('BAD_EVENT', 'event must be an object with a string type');
    }
    this.clock = Math.max(this.clock, e.clock ?? 0) + 1;
    switch (e.type) {
      case 'plan': this.#plan(e); break;
      case 'observe': this.#observe(e); break;
      case 'correct': this.#correct(e); break;
      case 'revoke': this.#revoke(e); break;
      case 'checkpoint': break;
      default: throw new DomainError('BAD_EVENT', `unknown event type: ${e.type}`);
    }
    this.log.push(e);
    if (e.type === 'checkpoint') this.onCheckpoint?.(this);
  }

  #plan(e) {
    if (!e.target) throw new DomainError('BAD_EVENT', 'plan requires a target id');
    checkWindow(e.window, `plan ${e.target}`);
    const sw = e.switch ?? 0;
    if (!(sw >= 0)) throw new DomainError('NEGATIVE_DURATION', `plan ${e.target}: negative switch cost`);
    this.targets.set(e.target, {
      id: e.target,
      pi: e.pi ?? 'default',
      window: [e.window[0], e.window[1]],
      value: e.value ?? 0,
      switch: sw,
      cloud: e.cloud === 'unknown' ? 'unknown' : 'clear',
      closed: false,
    });
    if (e.quota != null) this.quotas.set(e.pi ?? 'default', e.quota);
  }

  #observe(e) {
    if (!e.obs) throw new DomainError('BAD_EVENT', 'observe requires an obs id');
    const t = this.targets.get(e.target);
    if (!t) throw new DomainError('UNKNOWN_TARGET', `observe ${e.obs}: unknown target ${e.target}`);
    checkWindow(e.window, `observe ${e.obs}`);
    if (this.observations.has(e.obs)) {
      throw new DomainError('DUPLICATE_OBSERVATION', `observe ${e.obs}: duplicate observation id`);
    }
    if (t.closed || !t.window || e.window[0] < t.window[0] || e.window[1] > t.window[1]) {
      throw new DomainError('WINDOW_VIOLATION', `observe ${e.obs}: outside target window`);
    }
    for (const o of this.observations.values()) {
      if (overlaps(o.window, e.window)) {
        throw new DomainError('WINDOW_OVERLAP', `observe ${e.obs}: window overlaps observation ${o.id}`);
      }
    }
    this.observations.set(e.obs, {
      id: e.obs,
      target: e.target,
      pi: t.pi,
      switch: t.switch,
      window: [e.window[0], e.window[1]],
    });
  }

  #correct(e) {
    const t = this.targets.get(e.target);
    if (!t) throw new DomainError('UNKNOWN_TARGET', `correct: unknown target ${e.target}`);
    if (e.cloud === 'unknown') t.cloud = 'unknown';
    if (e.cloud === 'clear') t.cloud = 'clear';
    if (e.closed === true) {
      t.closed = true;
      t.window = null;
    }
    if (e.window != null) {
      checkWindow(e.window, `correct ${e.target}`);
      if (!t.window || e.window[0] < t.window[0] || e.window[1] > t.window[1]) {
        throw new DomainError('WINDOW_EXPANSION', `correct ${e.target}: corrections may only shorten or close windows`);
      }
      const [ns, ne] = e.window;
      // Preemption happens only at the correction boundary; evidence is saved.
      for (const o of [...this.observations.values()]) {
        if (o.target !== e.target) continue;
        const os = Math.max(o.window[0], ns);
        const oe = Math.min(o.window[1], ne);
        if (os >= oe) {
          this.evidence.push({
            type: 'preempted', obs: o.id, target: o.target,
            original: [...o.window], at: ne, reason: 'cloud-correction',
          });
          this.observations.delete(o.id);
        } else if (os !== o.window[0] || oe !== o.window[1]) {
          this.evidence.push({
            type: 'interrupted', obs: o.id, target: o.target,
            original: [...o.window], truncated: [os, oe], at: ne, reason: 'cloud-correction',
          });
          o.window = [os, oe];
        }
      }
      t.window = [ns, ne];
      t.closed = false;
      if (e.cloud == null) t.cloud = 'clear';
    }
  }

  #revoke(e) {
    if (!this.observations.has(e.obs)) {
      throw new DomainError('UNKNOWN_OBSERVATION', `revoke: unknown observation ${e.obs}`);
    }
    this.observations.delete(e.obs);
  }

  #skipReason(c, fixed) {
    const quota = this.quotas.get(c.pi);
    const confirmed = fixed.filter((f) => f.pi === c.pi).reduce((a, f) => a + (f.end - f.start), 0);
    if (quota != null && confirmed + (c.end - c.start) > quota) return 'quota-exhausted';
    const acts = [...fixed, c].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i + 1 < acts.length; i++) {
      if (acts[i].end + (acts[i + 1].switch ?? 0) > acts[i + 1].start) return 'window-conflict';
    }
    return 'not-selected';
  }

  schedule() {
    const fixed = [...this.observations.values()].map((o) => ({
      id: o.id, target: o.target, pi: o.pi,
      start: o.window[0], end: o.window[1], switch: o.switch,
    }));
    const skipped = [];
    const pending = [];
    const candidates = [];
    const pis = new Set([...this.quotas.keys()]);
    for (const f of fixed) pis.add(f.pi);
    const observedTargets = new Set(fixed.map((f) => f.target));
    for (const t of this.targets.values()) {
      pis.add(t.pi);
      if (observedTargets.has(t.id)) continue;
      if (t.closed) { skipped.push({ target: t.id, reason: 'window-closed' }); continue; }
      // Pending is not unsatisfiable: unknown cloud stays pending.
      if (t.cloud === 'unknown') { pending.push({ target: t.id, reason: 'cloud-unknown' }); continue; }
      candidates.push({ id: t.id, pi: t.pi, start: t.window[0], end: t.window[1], value: t.value, switch: t.switch });
    }
    const solution = solveSchedule({ candidates, fixed, quotas: this.quotas, pis: [...pis] });
    const selectedIds = new Set(solution.selected.map((s) => s.id));
    for (const c of candidates) {
      if (!selectedIds.has(c.id)) skipped.push({ target: c.id, reason: this.#skipReason(c, fixed) });
    }
    const sequence = [
      ...fixed.map((f) => ({ target: f.target, obs: f.id, pi: f.pi, start: f.start, end: f.end, status: 'confirmed' })),
      ...solution.selected.map((s) => ({ target: s.id, pi: s.pi, start: s.start, end: s.end, status: 'scheduled' })),
    ].sort((a, b) => a.start - b.start || (a.target < b.target ? -1 : 1));
    skipped.sort((a, b) => (a.target < b.target ? -1 : 1));
    pending.sort((a, b) => (a.target < b.target ? -1 : 1));
    return {
      sequence,
      skipped,
      pending,
      evidence: this.evidence,
      objective: { value: solution.value, maxDeficit: solution.maxDeficit, exposure: solution.exposure },
    };
  }

  certificate() {
    const result = this.schedule();
    const payload = canonical({ version: 1, clock: this.clock, log: this.log, result });
    return { algorithm: 'obs-sched/1', events: this.log.length, clock: this.clock, sha256: sha256(payload) };
  }

  snapshot() {
    return canonical({
      version: 1,
      clock: this.clock,
      targets: [...this.targets.values()].map((t) => ({ ...t, window: t.window ? [...t.window] : null })).sort(byId),
      quotas: [...this.quotas.entries()].map(([pi, quota]) => ({ pi, quota })).sort((a, b) => (a.pi < b.pi ? -1 : 1)),
      observations: [...this.observations.values()].map((o) => ({ ...o, window: [...o.window] })).sort(byId),
      evidence: this.evidence,
      log: this.log,
    });
  }

  static restore(text) {
    const data = JSON.parse(text);
    if (data.version !== 1) throw new DomainError('BAD_CHECKPOINT', 'unsupported checkpoint version');
    const s = new Store();
    s.clock = data.clock;
    for (const t of data.targets) s.targets.set(t.id, t);
    for (const q of data.quotas) s.quotas.set(q.pi, q.quota);
    for (const o of data.observations) s.observations.set(o.id, o);
    s.evidence = data.evidence;
    s.log = data.log;
    return s;
  }
}
