// Core streaming engine: windowing, hash/barcode join, case state machine.
// Pure in-memory; persistence lives in store.js. Deterministic: no wall clock.

export const HASH_RE = /^[0-9a-f]{64}$/;
export const WATERMARK_LAG_MS = 3000;

export class Engine {
  constructor({ watermarkLagMs = WATERMARK_LAG_MS } = {}) {
    this.watermarkLagMs = watermarkLagMs;
    this.maxTs = null;
    this.seq = 0;
    // frame -> { sku, caseId, barcodeActive, defects: Map<defect, hash>, hashBad }
    this.frames = new Map();
    // caseId -> { frames: Set<frameId> }
    this.cases = new Map();
    // sku -> { pass, active }
    this.audits = new Map();
    // append-only audit chain; retractions mark entries but never delete
    this.auditChain = [];
    this.late = [];
  }

  get watermark() {
    return this.maxTs === null ? null : this.maxTs - this.watermarkLagMs;
  }

  #frame(id) {
    let f = this.frames.get(id);
    if (!f) {
      f = { sku: null, caseId: null, barcodeActive: false, defects: new Map(), hashBad: false };
      this.frames.set(id, f);
    }
    return f;
  }

  #case(id) {
    let c = this.cases.get(id);
    if (!c) {
      c = { frames: new Set() };
      this.cases.set(id, c);
    }
    return c;
  }

  // Apply one event. Returns { late: boolean }.
  apply(event) {
    this.seq += 1;
    const wm = this.watermark;
    if (typeof event.eventTs === 'number' && wm !== null && event.eventTs < wm) {
      this.late.push({ seq: this.seq, reason: 'LATE', watermark: wm, event });
      return { late: true };
    }
    if (typeof event.eventTs === 'number' && (this.maxTs === null || event.eventTs > this.maxTs)) {
      this.maxTs = event.eventTs;
    }
    switch (event.type) {
      case 'vision': return this.#vision(event);
      case 'barcode': return this.#barcode(event);
      case 'audit': return this.#audit(event);
      case 'retract': return this.#retract(event);
      default: throw new Error(`UNKNOWN_EVENT_TYPE:${event.type}`);
    }
  }

  #vision(e) {
    const f = this.#frame(e.frame);
    f.sku = e.sku;
    if (!HASH_RE.test(e.hash)) f.hashBad = true; // HASH_BAD: not 64-char lowercase hex
    if (e.defect != null) f.defects.set(e.defect, e.hash); // defect:null = clean scan
    return { late: false };
  }

  #barcode(e) {
    const f = this.#frame(e.frame);
    if (f.barcodeActive && f.caseId !== null) this.#unbind(e.frame);
    f.caseId = e.case;
    f.barcodeActive = true;
    this.#case(e.case).frames.add(e.frame);
    return { late: false };
  }

  #audit(e) {
    this.audits.set(e.sku, { pass: !!e.pass, active: true });
    this.auditChain.push({ seq: this.seq, sku: e.sku, pass: !!e.pass, retracted: false });
    return { late: false };
  }

  #unbind(frameId) {
    const f = this.frames.get(frameId);
    if (f && f.caseId !== null) {
      const c = this.cases.get(f.caseId);
      if (c) c.frames.delete(frameId);
      f.caseId = null;
    }
    if (f) f.barcodeActive = false;
  }

  #retract(e) {
    if (e.kind === 'vision') {
      // Remove defect evidence for the frame; audit chain is untouched.
      const f = this.frames.get(e.id);
      if (f) {
        f.defects.clear();
        f.hashBad = false;
      }
    } else if (e.kind === 'barcode') {
      this.#unbind(e.id);
    } else if (e.kind === 'audit') {
      const a = this.audits.get(e.id);
      if (a) a.active = false; // released cases with this sku fall back to QUAR
      for (const entry of this.auditChain) {
        if (entry.sku === e.id) entry.retracted = true;
      }
    }
    return { late: false };
  }

  // Status of one case: CONFLICT > QUAR > RELEASED.
  caseStatus(caseId) {
    const c = this.cases.get(caseId);
    const frames = [...c.frames].sort();
    const skus = new Set();
    const defects = [];
    let hashBad = false;
    for (const fid of frames) {
      const f = this.frames.get(fid);
      if (f.sku != null) skus.add(f.sku);
      if (f.hashBad) hashBad = true;
      for (const d of f.defects.keys()) defects.push({ frame: fid, defect: d });
    }
    const skuList = [...skus].sort();
    if (skuList.length > 1) {
      return { case: caseId, status: 'CONFLICT', skus: skuList, frames, defects, error: hashBad ? 'HASH_BAD' : null };
    }
    const reasons = [];
    if (frames.length === 0) reasons.push('EMPTY');
    if (hashBad) reasons.push('HASH_BAD');
    if (defects.length > 0) reasons.push('DEFECT');
    const sku = skuList.length === 1 ? skuList[0] : null;
    const audit = sku ? this.audits.get(sku) : null;
    if (!(audit && audit.active && audit.pass)) reasons.push('NO_AUDIT_PASS');
    const status = reasons.length === 0 ? 'RELEASED' : 'QUAR';
    return { case: caseId, status, skus: skuList, frames, defects, reasons, error: hashBad ? 'HASH_BAD' : null };
  }

  // All cases with at least one bound frame, sorted by case id.
  caseStatuses() {
    return [...this.cases.keys()]
      .sort()
      .map((id) => this.caseStatus(id))
      .filter((s) => s.frames.length > 0);
  }
}

export function render(engine) {
  const statuses = engine.caseStatuses();
  const casesLines = statuses.map((s) => {
    const row = {
      case: s.case,
      status: s.status,
      skus: s.skus,
      frames: s.frames,
      defects: s.defects,
    };
    if (s.error) row.error = s.error;
    if (s.status === 'QUAR') row.reasons = s.reasons;
    return JSON.stringify(row);
  });
  const release = {
    watermarkLagMs: engine.watermarkLagMs,
    maxEventTs: engine.maxTs,
    watermark: engine.watermark,
    released: statuses.filter((s) => s.status === 'RELEASED').map((s) => s.case),
    quarantined: statuses.filter((s) => s.status === 'QUAR').map((s) => s.case),
    conflicts: statuses.filter((s) => s.status === 'CONFLICT').map((s) => s.case),
    errors: statuses.filter((s) => s.error).map((s) => ({ case: s.case, error: s.error })),
    auditTrail: engine.auditChain,
  };
  const lateLines = engine.late.map((l) => JSON.stringify(l));
  return {
    cases: casesLines.length ? casesLines.join('\n') + '\n' : '',
    release: JSON.stringify(release, null, 2) + '\n',
    late: lateLines.length ? lateLines.join('\n') + '\n' : '',
  };
}
