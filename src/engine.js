// Core release engine.
//
// Semantics:
// - Events are processed in input (arrival) order; watermark = maxEventTs - lag.
// - Events older than the watermark, and labs arriving after their batch fill
//   window closed, are logged to `late` but still applied (offline reconcile).
// - Per batch, base status is a pure function of the *active* fills and CIPs:
//     no fills            -> EMPTY   (NO_FILL)
//     vol <= 0            -> REJECT  (VOL_INVALID)
//     density out of band -> REJECT  (DENSITY_MISMATCH)   [terminal for labs]
//     fill outside a clean CIP window -> REJECT (CIP_WINDOW)
//     otherwise           -> HOLD    (AWAITING_LAB)  -- pending != unsatisfiable
// - Active labs (eventTs order) apply on top of HOLD only:
//     HOLD + pass -> RELEASE ; HOLD + fail -> REJECT (LAB_FAIL)
//   Labs never flip any REJECT.
// - retract removes an op and recomputes; every state change is appended to
//   `transitions` (append-only, monotonic seq) and retract-driven changes are
//   also recorded in `comp` as compensations. History is never rewritten.

export const DENSITY_MIN = 0.95; // g/mL
export const DENSITY_MAX = 1.10;
export const WATERMARK_LAG_MS = 3 * 60 * 1000; // 3 minutes

export const STATES = Object.freeze(['EMPTY', 'HOLD', 'RELEASE', 'REJECT']);

// A fill at time t is clean iff some ok CIP ended at or before t and no CIP
// (ok or not) started between that ok CIP's end and t (inclusive).
export function inCleanWindow(t, cips) {
  let lastOkEnd = -Infinity;
  for (const c of cips) {
    if (c.ok && c.end <= t && c.end > lastOkEnd) lastOkEnd = c.end;
  }
  if (lastOkEnd === -Infinity) return false;
  for (const c of cips) {
    if (c.start > lastOkEnd && c.start <= t) return false;
  }
  return true;
}

export class Engine {
  constructor(opts = {}) {
    this.densityMin = opts.densityMin ?? DENSITY_MIN;
    this.densityMax = opts.densityMax ?? DENSITY_MAX;
    this.watermarkLagMs = opts.watermarkLagMs ?? WATERMARK_LAG_MS;
    this.maxEventTs = null;
    this.ops = new Map();        // op -> active event (fill|cip|lab)
    this.batches = new Map();    // batch -> { fills: Map(op->e), labs: Map(op->e) }
    this.cips = new Map();       // op -> cip event
    this.state = new Map();      // batch -> { state, reason, appliedLabs: [] }
    this.transitions = [];       // append-only audit log
    this.comp = [];              // compensation records (retract rollbacks)
    this.late = [];              // late-event log entries
    this.seq = 0;
    this.processed = 0;
  }

  watermark() {
    return this.maxEventTs === null ? null : this.maxEventTs - this.watermarkLagMs;
  }

  #batch(name) {
    let b = this.batches.get(name);
    if (!b) {
      b = { fills: new Map(), labs: new Map() };
      this.batches.set(name, b);
    }
    return b;
  }

  process(event) {
    const wm = this.watermark();
    if (wm !== null && event.eventTs < wm) {
      this.late.push({
        reason: 'LATE_EVENT', type: event.type, op: event.op ?? event.id ?? null,
        batch: event.batch ?? null, eventTs: event.eventTs, watermark: wm,
      });
    }
    if (event.type === 'lab') {
      const b = this.batches.get(event.batch);
      if (b && b.fills.size > 0) {
        const windowEnd = Math.max(...[...b.fills.values()].map((f) => f.eventTs));
        if (wm !== null && wm > windowEnd) {
          this.late.push({
            reason: 'LATE_LAB_WINDOW_CLOSED', type: 'lab', op: event.op,
            batch: event.batch, eventTs: event.eventTs, watermark: wm, windowEnd,
          });
        }
      }
    }
    if (this.maxEventTs === null || event.eventTs > this.maxEventTs) {
      this.maxEventTs = event.eventTs;
    }
    this.processed += 1;
    switch (event.type) {
      case 'fill': {
        if (this.ops.has(event.op)) return; // duplicate op: idempotent
        this.ops.set(event.op, event);
        this.#batch(event.batch).fills.set(event.op, event);
        this.#recompute(event.batch, event);
        break;
      }
      case 'lab': {
        if (this.ops.has(event.op)) return;
        this.ops.set(event.op, event);
        this.#batch(event.batch).labs.set(event.op, { event, n: this.processed });
        this.#recompute(event.batch, event);
        break;
      }
      case 'cip': {
        if (this.ops.has(event.op)) return;
        this.ops.set(event.op, event);
        this.cips.set(event.op, event);
        // CIP boundaries are line-global: re-assign fills of every batch.
        for (const name of this.batches.keys()) this.#recompute(name, event);
        break;
      }
      case 'retract': {
        const target = this.ops.get(event.id);
        if (!target || target.type !== event.kind) return; // unknown/mismatched: no-op
        this.ops.delete(event.id);
        if (target.type === 'fill') {
          this.batches.get(target.batch).fills.delete(target.op);
          this.#recompute(target.batch, event);
        } else if (target.type === 'lab') {
          this.batches.get(target.batch).labs.delete(target.op);
          this.#recompute(target.batch, event);
        } else { // cip
          this.cips.delete(target.op);
          for (const name of this.batches.keys()) this.#recompute(name, event);
        }
        break;
      }
      default:
        throw new Error(`engine: unsupported event type ${event.type}`);
    }
  }

  // Pure evaluation of a batch from active fills + cips + labs.
  evaluate(name) {
    const b = this.#batch(name);
    const fills = [...b.fills.values()].sort((a, z) => a.eventTs - z.eventTs || a.op.localeCompare(z.op));
    let state;
    let reason;
    if (fills.length === 0) {
      state = 'EMPTY'; reason = 'NO_FILL';
    } else {
      state = 'HOLD'; reason = 'AWAITING_LAB';
      const cips = [...this.cips.values()];
      for (const f of fills) {
        if (!(f.vol > 0)) { state = 'REJECT'; reason = 'VOL_INVALID'; break; }
        const density = f.weight / f.vol;
        if (!(density >= this.densityMin && density <= this.densityMax)) {
          state = 'REJECT'; reason = 'DENSITY_MISMATCH'; break;
        }
        if (!inCleanWindow(f.eventTs, cips)) { state = 'REJECT'; reason = 'CIP_WINDOW'; break; }
      }
    }
    const appliedLabs = [];
    if (state === 'HOLD') {
      // Labs apply in arrival order; REJECT is absorbing for labs, so a
      // late-arriving pass can never rewrite an earlier fail (and vice versa
      // an earlier eventTs must not jump the queue). Only retract rolls back.
      const labs = [...b.labs.values()].sort((a, z) => a.n - z.n).map((x) => x.event);
      for (const l of labs) {
        if (state !== 'HOLD') break; // labs never flip REJECT; extra labs after RELEASE ignored
        state = l.pass ? 'RELEASE' : 'REJECT';
        reason = l.pass ? 'LAB_PASS' : 'LAB_FAIL';
        appliedLabs.push(l.op);
      }
    }
    return { state, reason, appliedLabs };
  }

  #recompute(name, cause) {
    const next = this.evaluate(name);
    const prev = this.state.get(name) ?? { state: 'EMPTY', reason: 'NO_FILL', appliedLabs: [] };
    this.state.set(name, next);
    if (prev.state === next.state && prev.reason === next.reason) return;
    const tr = {
      seq: ++this.seq,
      batch: name,
      from: prev.state,
      to: next.state,
      reason: next.reason,
      eventTs: cause.eventTs,
      trigger: cause.type,
      op: cause.op ?? cause.id ?? null,
    };
    this.transitions.push(tr);
    if (cause.type === 'retract') {
      this.comp.push({
        seq: tr.seq,
        batch: name,
        retractedKind: cause.kind,
        retractedId: cause.id,
        from: prev.state,
        to: next.state,
        reason: 'RETRACT_ROLLBACK',
        eventTs: cause.eventTs,
      });
    }
  }

  summary() {
    const rows = [];
    for (const [name, b] of [...this.batches.entries()].sort((a, z) => a[0].localeCompare(z[0]))) {
      const cur = this.state.get(name) ?? { state: 'EMPTY', reason: 'NO_FILL', appliedLabs: [] };
      const fills = [...b.fills.values()].sort((a, z) => a.eventTs - z.eventTs);
      rows.push({
        batch: name,
        state: cur.state,
        reason: cur.reason,
        fillCount: fills.length,
        window: fills.length
          ? { start: fills[0].eventTs, end: fills[fills.length - 1].eventTs }
          : null,
        labs: cur.appliedLabs,
        watermark: this.watermark(),
      });
    }
    return rows;
  }
}
