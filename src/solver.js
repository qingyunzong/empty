import { validateEvent, ValidationError, DuplicateIdError } from './event.js';
import { compareVC } from './vclock.js';
import { OrderState } from './order-state.js';

export { ValidationError, DuplicateIdError };

// Safety rules enforced by the solver:
//  - device-mutex: two events on the same device may not be concurrent;
//    every same-device pair must be ordered (they share one physical log).
//  - reset-before-run: on one device, if STOP precedes RUN then a RESET
//    must lie strictly between them (STOP -> RESET -> RUN causal chain).
export class Solver {
  constructor({ window = 5 } = {}) {
    this.window = window; // max clock skew: ts(a) + window <= ts(b) implies a -> b
    this.events = new Map(); // id -> validated event
    this.state = new OrderState();
    this.failedBaseEdges = []; // base edges currently forming a cycle
    this.baseConflict = null;
  }

  addEvent(raw) {
    const ev = validateEvent(raw);
    if (this.events.has(ev.id)) {
      throw new DuplicateIdError(`duplicate event id: ${ev.id}`);
    }
    this.events.set(ev.id, ev);
    this.state.addEvent(ev.id);
    for (const other of this.events.values()) {
      if (other.id !== ev.id) this.#linkBase(ev, other);
    }
    return ev;
  }

  // Correction = atomic retract + add of the same id.
  correctEvent(raw) {
    const ev = validateEvent(raw);
    if (this.events.has(ev.id)) this.retractEvent(ev.id);
    return this.addEvent(ev);
  }

  // Incremental retract: undo every trail entry whose derivation depends on
  // the removed event, then replay the surviving entries. Search nodes from
  // previous solve() calls were already restored by solve() itself, so the
  // trail here only holds base (event-derived) propagations.
  retractEvent(id) {
    if (!this.events.has(id)) {
      throw new ValidationError(`unknown event id: ${id}`);
    }
    const trail = this.state.trail;
    let cut = trail.length;
    for (let i = 0; i < trail.length; i++) {
      if (trail[i].deps.includes(id)) {
        cut = i;
        break;
      }
    }
    const saved = [];
    for (let i = cut + 1; i < trail.length; i++) {
      const entry = trail[i];
      if (entry.deps.includes(id)) continue;
      if (entry.type === 'addEvent' || entry.direct) saved.push(entry);
    }
    this.state.undoTo(cut);
    this.events.delete(id);
    const retryFailed = this.failedBaseEdges.filter((e) => !e.reason.deps.includes(id));
    this.failedBaseEdges = [];
    this.baseConflict = null;
    for (const entry of saved) {
      if (entry.type === 'addEvent') this.state.addEvent(entry.id);
      else this.#addBaseEdge(entry.from, entry.to, entry.reason);
    }
    // A base edge that previously closed a cycle may now be satisfiable.
    for (const edge of retryFailed) {
      this.#addBaseEdge(edge.from, edge.to, edge.reason);
    }
  }

  #linkBase(a, b) {
    const cmp = compareVC(a.vc, b.vc);
    if (cmp === 'lt') this.#addBaseEdge(a.id, b.id, { kind: 'vc', deps: [a.id, b.id] });
    else if (cmp === 'gt') this.#addBaseEdge(b.id, a.id, { kind: 'vc', deps: [a.id, b.id] });
    if (a.ts + this.window <= b.ts) {
      this.#addBaseEdge(a.id, b.id, { kind: 'window', deps: [a.id, b.id] });
    } else if (b.ts + this.window <= a.ts) {
      this.#addBaseEdge(b.id, a.id, { kind: 'window', deps: [a.id, b.id] });
    }
  }

  #addBaseEdge(from, to, reason) {
    const res = this.state.addEdge(from, to, reason);
    if (!res.ok) {
      this.failedBaseEdges.push({ from, to, reason });
      if (!this.baseConflict) this.baseConflict = res.conflict;
    }
  }

  #byDevice() {
    const map = new Map();
    for (const ev of this.events.values()) {
      if (!map.has(ev.device)) map.set(ev.device, []);
      map.get(ev.device).push(ev);
    }
    for (const evs of map.values()) {
      evs.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    }
    return map;
  }

  // Rule propagator: runs to a fixpoint, returns a conflict or null.
  #propagate() {
    for (;;) {
      let changed = false;
      for (const evs of this.#byDevice().values()) {
        const stops = evs.filter((e) => e.type === 'STOP');
        const runs = evs.filter((e) => e.type === 'RUN');
        const resets = evs.filter((e) => e.type === 'RESET');
        for (const s of stops) {
          for (const r of runs) {
            if (!this.state.isBefore(s.id, r.id)) continue;
            const between = (e) =>
              this.state.isBefore(s.id, e.id) && this.state.isBefore(e.id, r.id);
            if (resets.some(between)) continue;
            // RESET e can still be placed strictly between s and r iff it is
            // not already before s and not already after r.
            const candidates = resets.filter(
              (e) => !this.state.isBefore(e.id, s.id) && !this.state.isBefore(r.id, e.id),
            );
            if (candidates.length === 0) {
              return {
                rule: 'reset-before-run',
                events: [s.id, r.id],
                chain: this.state.pathChain(this.state.findPath(s.id, r.id)),
                detail:
                  `STOP "${s.id}" precedes RUN "${r.id}" on device "${s.device}" ` +
                  'with no RESET in between',
              };
            }
            if (candidates.length === 1) {
              const e = candidates[0];
              for (const [x, y] of [[s.id, e.id], [e.id, r.id]]) {
                if (this.state.isBefore(x, y)) continue;
                const res = this.state.addEdge(x, y, {
                  kind: 'rule',
                  rule: 'reset-before-run',
                  deps: [s.id, e.id, r.id],
                });
                if (!res.ok) return { ...res.conflict, rule: 'reset-before-run' };
                changed = true;
              }
            }
          }
        }
      }
      if (!changed) return null;
    }
  }

  // First same-device pair not yet ordered (device-mutex search node).
  #findPair() {
    const byDevice = this.#byDevice();
    for (const device of [...byDevice.keys()].sort()) {
      const evs = byDevice.get(device);
      for (let i = 0; i < evs.length; i++) {
        for (let j = i + 1; j < evs.length; j++) {
          const a = evs[i].id;
          const b = evs[j].id;
          if (!this.state.isBefore(a, b) && !this.state.isBefore(b, a)) return [a, b];
        }
      }
    }
    return null;
  }

  #collectPending(ctx) {
    const byDevice = this.#byDevice();
    for (const evs of byDevice.values()) {
      for (let i = 0; i < evs.length; i++) {
        for (let j = i + 1; j < evs.length; j++) {
          const a = evs[i].id;
          const b = evs[j].id;
          if (!this.state.isBefore(a, b) && !this.state.isBefore(b, a)) {
            ctx.pending.add(a);
            ctx.pending.add(b);
          }
        }
      }
    }
  }

  // Deterministic Kahn topo sort (ties broken by ts then id); also reports
  // whether the precedence relation has exactly one linear extension.
  #topoSort() {
    const n = this.state.size;
    const ids = this.state.ids;
    const done = new Array(n).fill(false);
    const order = [];
    let unique = true;
    for (let k = 0; k < n; k++) {
      const avail = [];
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        let blocked = false;
        for (let j = 0; j < n; j++) {
          if (!done[j] && this.state.before[j][i]) {
            blocked = true;
            break;
          }
        }
        if (!blocked) avail.push(i);
      }
      if (avail.length > 1) unique = false;
      avail.sort((x, y) => {
        const ex = this.events.get(ids[x]);
        const ey = this.events.get(ids[y]);
        return ex.ts - ey.ts || (ex.id < ey.id ? -1 : 1);
      });
      const pick = avail[0];
      done[pick] = true;
      order.push(ids[pick]);
    }
    return { order, unique };
  }

  // Depth-first search over concurrent branches. Restores the order state
  // to exactly its entry point before every return, so callers can rely on
  // trail checkpoints. Each branch attempt consumes one unit of budget.
  #search(ctx) {
    const checkpoint = this.state.trail.length;
    const conflict = this.#propagate();
    if (conflict) {
      this.state.undoTo(checkpoint);
      ctx.conflicts.push(conflict);
      return { status: 'fail', conflict };
    }
    const pair = this.#findPair();
    if (!pair) {
      const { order, unique } = this.#topoSort();
      this.state.undoTo(checkpoint);
      return { status: 'feasible', order, unique };
    }
    const [a, b] = pair;
    let sawUnknown = false;
    let lastConflict = null;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (ctx.budget <= 0) {
        sawUnknown = true;
        continue;
      }
      ctx.budget--;
      const branchCheckpoint = this.state.trail.length;
      this.state.addEdge(x, y, { kind: 'decision', deps: [x, y] });
      const res = this.#search(ctx);
      if (res.status === 'feasible') {
        this.state.undoTo(checkpoint);
        return res;
      }
      if (res.status === 'unknown') sawUnknown = true;
      else lastConflict = res.conflict;
      this.state.undoTo(branchCheckpoint);
    }
    if (sawUnknown) {
      this.#collectPending(ctx);
      this.state.undoTo(checkpoint);
      return { status: 'unknown' };
    }
    this.state.undoTo(checkpoint);
    return { status: 'fail', conflict: lastConflict };
  }

  // budget: number of branch attempts the search may perform.
  // Returns one of:
  //  {status:'feasible', order, positions, unique, conflicts, pending}
  //  {status:'infeasible', conflict, conflicts, pending}
  //  {status:'unknown', pending, conflicts}
  solve({ budget = Infinity } = {}) {
    if (this.baseConflict) {
      return {
        status: 'infeasible',
        conflict: this.baseConflict,
        conflicts: [this.baseConflict],
        pending: [],
      };
    }
    const checkpoint = this.state.trail.length;
    const ctx = { budget, conflicts: [], pending: new Set() };
    const res = this.#search(ctx);
    this.state.undoTo(checkpoint); // restore search nodes for the next solve
    if (res.status === 'feasible') {
      return {
        status: 'feasible',
        order: res.order,
        positions: Object.fromEntries(res.order.map((id, i) => [id, i])),
        unique: res.unique,
        conflicts: ctx.conflicts,
        pending: [],
      };
    }
    if (res.status === 'unknown') {
      return { status: 'unknown', pending: [...ctx.pending].sort(), conflicts: ctx.conflicts };
    }
    return {
      status: 'infeasible',
      conflict: res.conflict,
      conflicts: ctx.conflicts,
      pending: [],
    };
  }
}
