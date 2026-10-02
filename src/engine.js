import { DENSITY_MIN, DENSITY_MAX, WATERMARK_LAG_MS, STATUS, RANK } from './constants.js';
import { normalizeEvent } from './parse.js';

// ReleaseEngine folds an event stream (processed in arrival order) into
// per-batch release status.
//
// Semantics:
//  - Watermark = max event time seen - lag. Events older than the watermark
//    are "late": they are logged but still applied (a late lab may flip
//    HOLD -> RELEASE).
//  - A fill is CIP-valid iff it falls after the end of the most recent ok
//    CIP and before the start of the next CIP. A fill with no valid window
//    is *pending* (HOLD), never unsatisfiable: a late-arriving or retracted
//    CIP can re-attribute it to a different cleaning window.
//  - Weight/volume cross-check: every fill's density (weight/vol) must lie
//    inside [densityMin, densityMax]. A violation is unsatisfiable data:
//    the batch goes to REJECT and can never leave it (lab results cannot
//    flip REJECT). vol <= 0 is reported as VOL_INVALID and also rejects.
//  - Missing lab result pins a batch to HOLD. lab.pass=false stays HOLD.
//  - Retractions remove the referenced event and re-derive state. Rolling
//    RELEASE back to HOLD always emits a compensation record (comp.jsonl).
//  - Transitions are append-only and versioned per batch; rank may only
//    decrease via the RELEASE -> HOLD compensation path (enforced).
export class ReleaseEngine {
  constructor({ watermarkLagMs = WATERMARK_LAG_MS, densityMin = DENSITY_MIN, densityMax = DENSITY_MAX } = {}) {
    this.watermarkLagMs = watermarkLagMs;
    this.densityMin = densityMin;
    this.densityMax = densityMax;
    this.maxEventTs = -Infinity;
    this.seq = 0;
    this.transitions = [];
    this.comps = [];
    this.lates = [];
    this.errors = [];
    this.ops = new Map(); // `${kind}:${op}` -> true (duplicate detection)
    this.cips = [];       // active cip events
    this.batches = new Map();
  }

  batch(name) {
    let b = this.batches.get(name);
    if (!b) {
      b = { name, fills: new Map(), lab: null, status: STATUS.HOLD, version: 0, rejectReason: null, reason: 'INIT' };
      this.batches.set(name, b);
    }
    return b;
  }

  process(raw) {
    const event = normalizeEvent(raw);
    if (event.eventTs < this.maxEventTs - this.watermarkLagMs) {
      this.lates.push({
        eventTs: event.eventTs, kind: event.kind,
        ref: event.kind === 'retract' ? `${event.target}:${event.id}` : event.op,
        watermark: this.maxEventTs - this.watermarkLagMs,
      });
    }
    if (event.eventTs > this.maxEventTs) this.maxEventTs = event.eventTs;

    switch (event.kind) {
      case 'fill': return this.onFill(event);
      case 'cip': return this.onCip(event);
      case 'lab': return this.onLab(event);
      case 'retract': return this.onRetract(event);
    }
  }

  register(event) {
    const key = `${event.kind}:${event.op}`;
    if (this.ops.has(key)) {
      this.errors.push({ code: 'OP_DUPLICATE', kind: event.kind, op: event.op });
      return false;
    }
    this.ops.set(key, true);
    return true;
  }

  onFill(event) {
    if (!this.register(event)) return;
    const b = this.batch(event.batch);
    b.fills.set(event.op, event);
    if (!(event.vol > 0)) {
      this.errors.push({ code: 'VOL_INVALID', batch: event.batch, op: event.op, vol: event.vol });
      b.rejectReason = b.rejectReason ?? 'VOL_INVALID';
    } else {
      const density = event.weight / event.vol;
      if (density < this.densityMin || density > this.densityMax) {
        b.rejectReason = b.rejectReason ?? 'DENSITY_MISMATCH';
      }
    }
    this.reevaluate(b, event.eventTs);
  }

  onCip(event) {
    if (!this.register(event)) return;
    this.cips.push(event);
    // A new CIP can re-attribute fills of any batch (late CIP may fix a
    // pending window, or invalidate fills that now fall after its start).
    for (const b of this.batches.values()) this.reevaluate(b, event.eventTs);
  }

  onLab(event) {
    if (!this.register(event)) return;
    const b = this.batch(event.batch);
    b.lab = { pass: event.pass, op: event.op };
    this.reevaluate(b, event.eventTs);
  }

  onRetract(event) {
    const key = `${event.target}:${event.id}`;
    if (!this.ops.has(key)) {
      this.errors.push({ code: 'RETRACT_UNKNOWN', target: event.target, id: event.id });
      return;
    }
    this.ops.delete(key);
    if (event.target === 'fill') {
      for (const b of this.batches.values()) {
        if (b.fills.delete(event.id)) this.reevaluate(b, event.eventTs);
      }
    } else if (event.target === 'cip') {
      const i = this.cips.findIndex((c) => c.op === event.id);
      if (i >= 0) this.cips.splice(i, 1);
      // CIP retraction re-attributes fills across cleaning boundaries.
      for (const b of this.batches.values()) this.reevaluate(b, event.eventTs);
    } else if (event.target === 'lab') {
      for (const b of this.batches.values()) {
        if (b.lab && b.lab.op === event.id) {
          b.lab = null;
          this.reevaluate(b, event.eventTs);
        }
      }
    }
  }

  // A fill is valid iff it falls after the end of the most recent ok CIP
  // and strictly before the start of the next CIP of any kind.
  inCipWindow(fillTs) {
    let lastOk = null;
    for (const c of this.cips) {
      if (c.ok && c.end <= fillTs && (!lastOk || c.end > lastOk.end)) lastOk = c;
    }
    if (!lastOk) return false;
    for (const c of this.cips) {
      if (c !== lastOk && c.start >= lastOk.end && c.start <= fillTs) return false;
    }
    return true;
  }

  derive(b) {
    if (b.rejectReason) return [STATUS.REJECT, b.rejectReason];
    if (b.fills.size === 0) return [STATUS.HOLD, 'NO_FILL'];
    for (const f of b.fills.values()) {
      if (!this.inCipWindow(f.eventTs)) return [STATUS.HOLD, 'CIP_WINDOW_PENDING'];
    }
    if (!b.lab) return [STATUS.HOLD, 'LAB_PENDING'];
    if (!b.lab.pass) return [STATUS.HOLD, 'LAB_FAIL'];
    return [STATUS.RELEASE, 'OK'];
  }

  reevaluate(b, eventTs) {
    const [to, reason] = this.derive(b);
    b.reason = reason;
    if (to === b.status) return;
    const from = b.status;
    const isCompensation = from === STATUS.RELEASE && to === STATUS.HOLD;
    if (RANK[to] < RANK[from] && !isCompensation) {
      throw new Error(`non-monotonic transition ${from} -> ${to} for batch ${b.name}`);
    }
    b.version += 1;
    b.status = to;
    this.seq += 1;
    this.transitions.push({
      seq: this.seq, batch: b.name, from, to, version: b.version, reason, eventTs,
    });
    if (isCompensation) {
      this.comps.push({
        seq: this.seq, batch: b.name, action: 'COMPENSATE_RELEASE',
        from, to, reason, eventTs,
      });
    }
  }

  finalize() {
    const out = [];
    for (const b of [...this.batches.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      let totalVol = 0;
      let totalWeight = 0;
      for (const f of b.fills.values()) { totalVol += f.vol; totalWeight += f.weight; }
      out.push({
        batch: b.name,
        status: b.status,
        version: b.version,
        reason: b.reason,
        fills: b.fills.size,
        totalVol,
        totalWeight,
        density: totalVol > 0 ? totalWeight / totalVol : null,
        lab: b.lab ? b.lab.pass : null,
      });
    }
    return out;
  }
}
