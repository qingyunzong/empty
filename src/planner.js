'use strict';

const { Rational } = require('./rational');
const { Poly } = require('./poly');

const MAX_DEGREE = 5;
const MAX_QUANTUM_EXP = 30;

class PlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function pow10(k) {
  return 10n ** BigInt(k);
}

// Round to the nearest multiple of 10^-k, ties (exact halves) rounded up
// towards +infinity. Exact rational computation.
function quantize(x, k) {
  x = Rational.from(x);
  const m = pow10(k);
  const scaled = x.mul(new Rational(m));
  const n = scaled.add(new Rational(1n, 2n)).floor();
  return new Rational(n, m);
}

function normalizeParams(raw) {
  if (raw == null || typeof raw !== 'object') {
    throw new PlannerError('E_INVALID_PARAMS', 'params object is required');
  }
  const k = raw.quantumExp;
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k > MAX_QUANTUM_EXP) {
    throw new PlannerError('E_INVALID_QUANTUM', `quantumExp must be an integer in [0, ${MAX_QUANTUM_EXP}]`);
  }
  let slot;
  try {
    slot = Rational.from(raw.slot);
  } catch (e) {
    throw new PlannerError('E_INVALID_PARAMS', `invalid slot: ${e.message}`);
  }
  if (slot.sign() <= 0) {
    throw new PlannerError('E_INVALID_PARAMS', 'slot must be a positive rational');
  }
  let segmentTolerance;
  let totalTolerance;
  try {
    segmentTolerance = Rational.from(raw.segmentTolerance);
    totalTolerance = Rational.from(raw.totalTolerance);
  } catch (e) {
    throw new PlannerError('E_INVALID_PARAMS', `invalid tolerance: ${e.message}`);
  }
  if (segmentTolerance.sign() < 0 || totalTolerance.sign() < 0) {
    throw new PlannerError('E_INVALID_PARAMS', 'tolerances must be non-negative rationals');
  }
  return { quantumExp: k, slot, segmentTolerance, totalTolerance };
}

function normalizeSegment(raw, index) {
  const where = `segment ${index}`;
  if (raw == null || typeof raw !== 'object') {
    throw new PlannerError('E_INVALID_SEGMENT', `${where}: object expected`);
  }
  if (!Array.isArray(raw.coeffs) || raw.coeffs.length === 0) {
    throw new PlannerError('E_INVALID_SEGMENT', `${where}: coeffs must be a non-empty array`);
  }
  let poly;
  let a;
  let b;
  try {
    poly = new Poly(raw.coeffs);
    a = Rational.from(raw.a);
    b = Rational.from(raw.b);
  } catch (e) {
    throw new PlannerError('E_INVALID_SEGMENT', `${where}: ${e.message}`);
  }
  if (poly.degree() > MAX_DEGREE) {
    throw new PlannerError('E_DEGREE', `${where}: degree ${poly.degree()} exceeds ${MAX_DEGREE}`);
  }
  if (a.cmp(b) >= 0) {
    throw new PlannerError('E_INVALID_INTERVAL', `${where}: require a < b, got a=${a}, b=${b}`);
  }
  if (poly.hasNegativeOn(a, b)) {
    throw new PlannerError('E_NEGATIVE_VELOCITY', `${where}: velocity is negative inside [${a}, ${b}]`);
  }
  return { poly, a, b };
}

// Slot boundaries are the fixed rational grid n*slot. A segment [a,b] emits one
// increment per grid cell intersected with [a,b].
function slotIntervals(a, b, slot) {
  const out = [];
  let n = a.div(slot).floor();
  for (;;) {
    const lo = slot.mul(new Rational(n));
    const hi = slot.mul(new Rational(n + 1n));
    const L = lo.cmp(a) > 0 ? lo : a;
    const H = hi.cmp(b) < 0 ? hi : b;
    if (L.cmp(H) < 0) out.push([L, H]);
    if (hi.cmp(b) >= 0) break;
    n += 1n;
  }
  return out;
}

// Builds the certificate for a full trajectory and enforces the tolerance
// contract. Throws PlannerError('E_TOLERANCE') on violation; callers must not
// emit any trajectory in that case.
function buildCertificate(segments, params) {
  const unit = new Rational(1n, pow10(params.quantumExp));
  const slotBound = unit.div(new Rational(2n)); // -u/2 < err <= u/2 (round half up)
  let cumulativeAbsError = Rational.zero();
  let cumulativeErrorBound = Rational.zero();
  const outSegments = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const slots = [];
    let segAbsError = Rational.zero();
    let segNetError = Rational.zero();
    let segQuantized = Rational.zero();
    let segBound = Rational.zero();

    for (const [lo, hi] of slotIntervals(seg.a, seg.b, params.slot)) {
      const exact = seg.poly.integrate(lo, hi);
      const quantized = quantize(exact, params.quantumExp);
      const err = quantized.sub(exact);
      slots.push({
        interval: [lo.toString(), hi.toString()],
        exact: exact.toString(),
        quantized: quantized.toString(),
        signedError: err.toString(),
        absError: err.abs().toString(),
        errorBound: slotBound.toString(),
      });
      segAbsError = segAbsError.add(err.abs());
      segNetError = segNetError.add(err);
      segQuantized = segQuantized.add(quantized);
      segBound = segBound.add(slotBound);
    }

    cumulativeAbsError = cumulativeAbsError.add(segAbsError);
    cumulativeErrorBound = cumulativeErrorBound.add(segBound);

    if (segAbsError.cmp(params.segmentTolerance) > 0) {
      throw new PlannerError(
        'E_TOLERANCE',
        `segment ${i}: cumulative absolute error ${segAbsError} exceeds segment tolerance ${params.segmentTolerance}`,
      );
    }
    if (cumulativeAbsError.cmp(params.totalTolerance) > 0) {
      throw new PlannerError(
        'E_TOLERANCE',
        `cumulative absolute error ${cumulativeAbsError} exceeds total tolerance ${params.totalTolerance}`,
      );
    }

    outSegments.push({
      index: i,
      interval: [seg.a.toString(), seg.b.toString()],
      coeffs: seg.poly.coeffs.map((c) => c.toString()),
      exactIntegral: seg.poly.integrate(seg.a, seg.b).toString(),
      quantized: segQuantized.toString(),
      netError: segNetError.toString(),
      absError: segAbsError.toString(),
      errorBound: segBound.toString(),
      cumulativeAbsError: cumulativeAbsError.toString(),
      cumulativeErrorBound: cumulativeErrorBound.toString(),
      slots,
    });
  }

  return {
    quantumExp: params.quantumExp,
    quantum: unit.toString(),
    slot: params.slot.toString(),
    segmentTolerance: params.segmentTolerance.toString(),
    totalTolerance: params.totalTolerance.toString(),
    segmentCount: outSegments.length,
    totalAbsError: cumulativeAbsError.toString(),
    totalErrorBound: cumulativeErrorBound.toString(),
    segments: outSegments,
  };
}

function cloneState(state) {
  return { segments: state.segments.slice(), params: state.params };
}

class FeedPlanner {
  constructor(params) {
    const normalized = normalizeParams(params);
    this._states = [{ segments: [], params: normalized }];
    this._index = 0;
    this._pending = null;
  }

  get _state() {
    return this._states[this._index];
  }

  beginEdit() {
    if (this._pending) throw new PlannerError('E_EDIT_ACTIVE', 'an edit transaction is already open');
    this._pending = cloneState(this._state);
    return { ok: true };
  }

  _requireEdit() {
    if (!this._pending) throw new PlannerError('E_NO_EDIT', 'no open edit transaction; call beginEdit first');
    return this._pending;
  }

  addSegment(seg) {
    const pending = this._requireEdit();
    pending.segments.push(seg);
    return { ok: true, pendingSegments: pending.segments.length };
  }

  setParams(params) {
    const pending = this._requireEdit();
    pending.params = { ...pending.params, ...params };
    return { ok: true };
  }

  // Validates the pending edit atomically. On any failure the transaction is
  // rolled back and no trajectory is produced.
  commit() {
    const pending = this._requireEdit();
    try {
      const params = normalizeParams(pending.params);
      const segments = pending.segments.map((s, i) =>
        s && s.poly instanceof Poly ? s : normalizeSegment(s, i));
      const certificate = buildCertificate(segments, params);
      this._states = this._states.slice(0, this._index + 1);
      this._states.push({ segments, params });
      this._index++;
      this._pending = null;
      return { ok: true, certificate };
    } catch (e) {
      this._pending = null; // rollback: committed state untouched
      if (e instanceof PlannerError) {
        return { ok: false, code: e.code, message: e.message };
      }
      throw e;
    }
  }

  rollback() {
    this._pending = null;
    return { ok: true };
  }

  undo() {
    if (this._pending) throw new PlannerError('E_EDIT_ACTIVE', 'cannot undo while an edit is open');
    if (this._index === 0) return { ok: false, code: 'E_NOTHING_TO_UNDO', message: 'nothing to undo' };
    this._index--;
    return { ok: true, certificate: this.certificate() };
  }

  redo() {
    if (this._pending) throw new PlannerError('E_EDIT_ACTIVE', 'cannot redo while an edit is open');
    if (this._index >= this._states.length - 1) {
      return { ok: false, code: 'E_NOTHING_TO_REDO', message: 'nothing to redo' };
    }
    this._index++;
    return { ok: true, certificate: this.certificate() };
  }

  certificate() {
    return buildCertificate(this._state.segments, this._state.params);
  }
}

module.exports = {
  FeedPlanner,
  PlannerError,
  quantize,
  buildCertificate,
  normalizeParams,
  normalizeSegment,
  slotIntervals,
  MAX_DEGREE,
};
