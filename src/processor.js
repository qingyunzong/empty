export const WINDOW_MS = 10_000;
export const WATERMARK_DELAY_MS = 3_000;

const frameKey = (window, frame) => `${window}|${typeof frame}:${String(frame)}`;

export function compareVals(a, b) {
  const ta = typeof a;
  const tb = typeof b;
  if (ta === 'number' && tb === 'number') return a - b;
  if (ta === 'number') return -1;
  if (tb === 'number') return 1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export class Processor {
  constructor() {
    this.maxEventTs = null;
    this.watermark = null;
    this.frameCase = new Map(); // frameKey -> {frame, case, window, op, retracted}
    this.barcodeByOp = new Map();
    this.visions = []; // {frame, sku, defect, hash, op, window, retracted}
    this.visionByOp = new Map();
    this.auditsBySku = new Map(); // sku -> [{pass, op, retracted}]
    this.auditByOp = new Map();
    this.late = []; // {seq, reason, event}
    this.unmatchedRetracts = 0;
  }

  windowOf(ts) {
    return Math.floor(ts / WINDOW_MS);
  }

  // Returns 'applied' or 'late'. Late events are rejected before touching state.
  apply(seq, ev) {
    if (this.watermark !== null && ev.eventTs < this.watermark) {
      this.late.push({ seq, reason: 'LATE', event: ev });
      return 'late';
    }
    if (this.maxEventTs === null || ev.eventTs > this.maxEventTs) {
      this.maxEventTs = ev.eventTs;
      this.watermark = this.maxEventTs - WATERMARK_DELAY_MS;
    }
    switch (ev.kind) {
      case 'barcode': {
        if (this.barcodeByOp.has(ev.op)) break;
        const rec = {
          frame: ev.frame, case: ev.case, window: this.windowOf(ev.eventTs), op: ev.op, retracted: false,
        };
        this.barcodeByOp.set(ev.op, rec);
        this.frameCase.set(frameKey(rec.window, ev.frame), rec);
        break;
      }
      case 'vision': {
        const rec = {
          frame: ev.frame, sku: ev.sku, defect: ev.defect, hash: ev.hash,
          op: ev.op, window: this.windowOf(ev.eventTs), retracted: false,
        };
        this.visions.push(rec);
        if (!this.visionByOp.has(ev.op)) this.visionByOp.set(ev.op, rec);
        break;
      }
      case 'audit': {
        const rec = { sku: ev.sku, pass: ev.pass, op: ev.op, retracted: false };
        if (!this.auditsBySku.has(ev.sku)) this.auditsBySku.set(ev.sku, []);
        this.auditsBySku.get(ev.sku).push(rec);
        if (!this.auditByOp.has(ev.op)) this.auditByOp.set(ev.op, rec);
        break;
      }
      case 'retract': {
        const map = ev.target === 'vision' ? this.visionByOp
          : ev.target === 'audit' ? this.auditByOp
            : this.barcodeByOp;
        const rec = map.get(ev.id);
        if (!rec || rec.retracted) {
          this.unmatchedRetracts += 1;
          break;
        }
        rec.retracted = true;
        if (ev.target === 'barcode') this.frameCase.delete(frameKey(rec.window, rec.frame));
        break;
      }
      default:
        break;
    }
    return 'applied';
  }

  effectiveAudit(sku) {
    const list = this.auditsBySku.get(sku) ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!list[i].retracted) return list[i];
    }
    return null;
  }

  // Joins vision evidence with barcode frame->case assignments inside the same
  // event-time window and derives one state per case.
  finalize() {
    const cases = new Map(); // caseId -> Map(window -> Set(frame))
    for (const rec of this.frameCase.values()) {
      if (rec.retracted) continue;
      if (!cases.has(rec.case)) cases.set(rec.case, new Map());
      const wins = cases.get(rec.case);
      if (!wins.has(rec.window)) wins.set(rec.window, new Set());
      wins.get(rec.window).add(rec.frame);
    }
    const out = [];
    for (const [caseId, wins] of cases) {
      const windows = [...wins.keys()].sort((a, b) => a - b);
      const frameRefs = [];
      for (const w of windows) {
        for (const f of wins.get(w)) frameRefs.push({ window: w, frame: f });
      }
      const joined = [];
      for (const v of this.visions) {
        if (v.retracted) continue;
        for (const ref of frameRefs) {
          if (v.window === ref.window && v.frame === ref.frame) joined.push(v);
        }
      }
      const skus = [...new Set(joined.map((v) => v.sku))].sort();
      const defects = joined
        .filter((v) => v.defect !== null && v.defect !== undefined)
        .map((v) => ({ frame: v.frame, defect: v.defect, hash: v.hash }))
        .sort((a, b) => compareVals(a.frame, b.frame) || compareVals(a.hash, b.hash));
      let state;
      if (skus.length > 1) state = 'CONFLICT';
      else if (defects.length > 0) state = 'QUAR';
      else if (skus.length === 1) {
        const audit = this.effectiveAudit(skus[0]);
        state = audit && audit.pass ? 'RELEASE' : 'QUAR';
      } else state = 'QUAR';
      const frames = [...new Set(frameRefs.map((r) => r.frame))].sort(compareVals);
      out.push({ case: caseId, state, skus, frames, defects, windows });
    }
    out.sort((a, b) => compareVals(a.case, b.case));
    return out;
  }
}

export function buildRelease(cases, watermark, maxEventTs) {
  const count = (s) => cases.filter((c) => c.state === s).length;
  return {
    version: 1,
    watermark,
    maxEventTs,
    released: cases.filter((c) => c.state === 'RELEASE').map((c) => c.case),
    counts: {
      total: cases.length,
      RELEASE: count('RELEASE'),
      QUAR: count('QUAR'),
      CONFLICT: count('CONFLICT'),
    },
  };
}
