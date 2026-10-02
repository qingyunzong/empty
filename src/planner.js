import { Rat, RAT_ZERO } from './rational.js';
import { quantize } from './quantize.js';
import {
  antiderivative,
  degree,
  evalPoly,
  isNonNegativeOn,
  monomialSumIntegral,
  trim,
} from './polynomial.js';

export class CncError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CncError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const MAX_DEGREE = 5;
export const MAX_K = 100;
export const MAX_SLOTS = 1000000;

function parseRatField(value, field, code) {
  if (value === undefined || value === null) {
    throw new CncError(code, `missing rational field: ${field}`);
  }
  try {
    return Rat.of(value);
  } catch {
    throw new CncError(code, `invalid rational for ${field}: ${JSON.stringify(value)}`);
  }
}

export function normalizeParams(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CncError('E_INVALID_QUANTIZATION', 'params object is required');
  }
  let k = raw.k;
  if (typeof k === 'string' && /^[+-]?\d+$/.test(k.trim())) k = Number(k);
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k > MAX_K) {
    throw new CncError('E_INVALID_QUANTIZATION', `k must be an integer in [0, ${MAX_K}]`);
  }
  const slot = parseRatField(raw.slot, 'slot', 'E_INVALID_QUANTIZATION');
  if (slot.sign() <= 0) {
    throw new CncError('E_INVALID_QUANTIZATION', 'slot width must be a positive rational');
  }
  const segmentTolerance = parseRatField(raw.segmentTolerance, 'segmentTolerance', 'E_INVALID_TOLERANCE');
  const totalTolerance = parseRatField(raw.totalTolerance, 'totalTolerance', 'E_INVALID_TOLERANCE');
  if (segmentTolerance.sign() < 0 || totalTolerance.sign() < 0) {
    throw new CncError('E_INVALID_TOLERANCE', 'tolerances must be non-negative rationals');
  }
  return { k, slot, segmentTolerance, totalTolerance };
}

export function normalizeSegment(raw, index) {
  const fail = (msg) => {
    throw new CncError('E_INVALID_SEGMENT', `segment ${index}: ${msg}`);
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('must be an object');
  let { a, b } = raw;
  if ((a === undefined || b === undefined) && Array.isArray(raw.interval)) [a, b] = raw.interval;
  const ra = parseRatField(a, `segments[${index}].a`, 'E_INVALID_SEGMENT');
  const rb = parseRatField(b, `segments[${index}].b`, 'E_INVALID_SEGMENT');
  if (ra.cmp(rb) >= 0) fail(`require a < b, got a=${ra}, b=${rb}`);
  if (!Array.isArray(raw.coeffs) || raw.coeffs.length === 0) fail('coeffs must be a non-empty array');
  const coeffs = trim(
    raw.coeffs.map((c, i) => parseRatField(c, `segments[${index}].coeffs[${i}]`, 'E_INVALID_SEGMENT')),
  );
  if (degree(coeffs) > MAX_DEGREE) fail(`degree ${degree(coeffs)} exceeds maximum ${MAX_DEGREE}`);
  return { coeffs, a: ra, b: rb };
}

// Pure validation + certificate construction. Throws CncError on any
// violation; on success returns the certificate (the "trajectory").
export function buildTrajectory(segments, params) {
  const unit = new Rat(1n, 10n ** BigInt(params.k));
  const halfUnit = unit.div(Rat.int(2));
  const certSegments = [];
  let totalExact = RAT_ZERO;
  let totalQuantized = RAT_ZERO;
  let totalAbsError = RAT_ZERO;
  let totalBound = RAT_ZERO;
  let slotTotal = 0;

  segments.forEach((seg, index) => {
    if (!isNonNegativeOn(seg.coeffs, seg.a, seg.b)) {
      throw new CncError(
        'E_NEGATIVE_VELOCITY',
        `segment ${index}: velocity is negative somewhere on [${seg.a}, ${seg.b}]`,
        { segment: index },
      );
    }
    const anti = antiderivative(seg.coeffs);
    const exactIntegral = evalPoly(anti, seg.b).sub(evalPoly(anti, seg.a));
    if (degree(seg.coeffs) <= 4) {
      const crossCheck = monomialSumIntegral(seg.coeffs, seg.a, seg.b);
      if (!crossCheck.eq(exactIntegral)) {
        throw new CncError('E_INTERNAL', `segment ${index}: integral cross-check failed`);
      }
    }
    const slots = [];
    let segAbsError = RAT_ZERO;
    let segQuantized = RAT_ZERO;
    let t = seg.a;
    while (t.cmp(seg.b) < 0) {
      slotTotal += 1;
      if (slotTotal > MAX_SLOTS) {
        throw new CncError('E_INVALID_QUANTIZATION', `too many slots (limit ${MAX_SLOTS})`);
      }
      const candidate = t.add(params.slot);
      const next = candidate.cmp(seg.b) < 0 ? candidate : seg.b;
      const exact = evalPoly(anti, next).sub(evalPoly(anti, t));
      const quantized = quantize(exact, params.k);
      const absError = quantized.sub(exact).abs();
      slots.push({
        interval: [t.toString(), next.toString()],
        exact: exact.toString(),
        quantized: quantized.toString(),
        absError: absError.toString(),
        errorBound: halfUnit.toString(),
      });
      segAbsError = segAbsError.add(absError);
      segQuantized = segQuantized.add(quantized);
      t = next;
    }
    const segBound = halfUnit.mul(Rat.int(slots.length));
    if (segAbsError.cmp(params.segmentTolerance) > 0) {
      throw new CncError(
        'E_TOLERANCE',
        `segment ${index}: cumulative absolute error ${segAbsError} exceeds segment tolerance ${params.segmentTolerance}`,
        { segment: index, error: segAbsError.toString(), tolerance: params.segmentTolerance.toString() },
      );
    }
    certSegments.push({
      index,
      interval: [seg.a.toString(), seg.b.toString()],
      coeffs: seg.coeffs.map((c) => c.toString()),
      degree: degree(seg.coeffs),
      exactIntegral: exactIntegral.toString(),
      quantizedTotal: segQuantized.toString(),
      slots,
      cumulativeAbsError: segAbsError.toString(),
      cumulativeErrorBound: segBound.toString(),
      tolerance: params.segmentTolerance.toString(),
    });
    totalExact = totalExact.add(exactIntegral);
    totalQuantized = totalQuantized.add(segQuantized);
    totalAbsError = totalAbsError.add(segAbsError);
    totalBound = totalBound.add(segBound);
  });

  if (totalAbsError.cmp(params.totalTolerance) > 0) {
    throw new CncError(
      'E_TOLERANCE',
      `total cumulative absolute error ${totalAbsError} exceeds total tolerance ${params.totalTolerance}`,
      { error: totalAbsError.toString(), tolerance: params.totalTolerance.toString() },
    );
  }

  return {
    params: {
      k: params.k,
      slot: params.slot.toString(),
      unit: unit.toString(),
      segmentTolerance: params.segmentTolerance.toString(),
      totalTolerance: params.totalTolerance.toString(),
    },
    segments: certSegments,
    totalExactIntegral: totalExact.toString(),
    totalQuantized: totalQuantized.toString(),
    cumulativeAbsError: totalAbsError.toString(),
    cumulativeErrorBound: totalBound.toString(),
    totalTolerance: params.totalTolerance.toString(),
  };
}

function emptyCertificate() {
  return {
    params: null,
    segments: [],
    totalExactIntegral: '0',
    totalQuantized: '0',
    cumulativeAbsError: '0',
    cumulativeErrorBound: '0',
    totalTolerance: null,
  };
}

export class Planner {
  #history;
  #pos;

  constructor() {
    this.#history = [{ certificate: emptyCertificate() }];
    this.#pos = 0;
  }

  get certificate() {
    return structuredClone(this.#history[this.#pos].certificate);
  }

  // Transactional edit: the whole segment list is validated and integrated;
  // any failure leaves the current state untouched (rollback).
  commit(edit) {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      throw new CncError('E_INVALID_INPUT', 'commit edit must be an object');
    }
    const params = normalizeParams(edit.params ?? edit);
    if (!Array.isArray(edit.segments)) {
      throw new CncError('E_INVALID_INPUT', 'segments array is required');
    }
    const segments = edit.segments.map((s, i) => normalizeSegment(s, i));
    const certificate = buildTrajectory(segments, params);
    this.#history = this.#history.slice(0, this.#pos + 1);
    this.#history.push({ certificate });
    this.#pos += 1;
    return structuredClone(certificate);
  }

  undo() {
    if (this.#pos === 0) throw new CncError('E_UNDO_EMPTY', 'nothing to undo');
    this.#pos -= 1;
    return this.certificate;
  }

  redo() {
    if (this.#pos >= this.#history.length - 1) throw new CncError('E_REDO_EMPTY', 'nothing to redo');
    this.#pos += 1;
    return this.certificate;
  }
}
