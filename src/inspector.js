import {
  Rat, rat, ZERO, ONE,
  roundToScaledInt, formatScaledInt, roundingErrorBound, assertDecimals,
} from './rational.js';
import { E, QError } from './errors.js';
import { parsePolynomial, mapInterval } from './polynomial.js';
import { validatePolygon, classifyBox } from './geometry.js';

const identityCoeffs = () => [ZERO, ONE, ZERO];

/**
 * Quality-inspection engine. All mutations are transactional: inputs are fully
 * validated before any state changes, and a failure restores the previous
 * snapshot, so recorded judgments are never corrupted by a failed operation.
 */
export class Inspector {
  #tolerance = null; // { vertices: [{x,y}], orientation } | null
  #correction = { version: 'identity', x: identityCoeffs(), y: identityCoeffs() };
  #points = new Map(); // id -> { id, x: {lo,hi}, y: {lo,hi} }
  #judgments = new Map(); // id -> judgment (exact Rat values)
  #past = [];
  #future = [];

  get pointCount() { return this.#points.size; }

  // ---- serialization for snapshots -------------------------------------

  #snapshot() {
    return JSON.stringify({
      tolerance: this.#tolerance && {
        vertices: this.#tolerance.vertices.map((v) => [v.x.toString(), v.y.toString()]),
      },
      correction: {
        version: this.#correction.version,
        x: this.#correction.x.map(String),
        y: this.#correction.y.map(String),
      },
      points: [...this.#points.values()].map((p) => ({
        id: p.id,
        x: [p.x.lo.toString(), p.x.hi.toString()],
        y: [p.y.lo.toString(), p.y.hi.toString()],
      })),
    });
  }

  #restore(snap) {
    const s = JSON.parse(snap);
    this.#tolerance = s.tolerance
      ? validatePolygon(s.tolerance.vertices.map(([x, y]) => ({ x: rat(x), y: rat(y) })))
      : null;
    this.#correction = {
      version: s.correction.version,
      x: s.correction.x.map(rat),
      y: s.correction.y.map(rat),
    };
    this.#points = new Map(s.points.map((p) => [p.id, {
      id: p.id,
      x: { lo: rat(p.x[0]), hi: rat(p.x[1]) },
      y: { lo: rat(p.y[0]), hi: rat(p.y[1]) },
    }]));
    this.#recompute();
  }

  #transact(mutate) {
    const before = this.#snapshot();
    try {
      mutate();
      this.#recompute();
    } catch (err) {
      this.#restore(before);
      throw err;
    }
    this.#past.push(before);
    this.#future = [];
  }

  // ---- operations --------------------------------------------------------

  setTolerance(polygonSpec) {
    if (!Array.isArray(polygonSpec)) {
      throw new QError(E.GEOMETRY, 'polygon must be an array of [x, y] vertices');
    }
    const vertices = polygonSpec.map((v, i) => {
      if (!Array.isArray(v) || v.length !== 2) {
        throw new QError(E.GEOMETRY, `polygon vertex ${i} must be a [x, y] pair`);
      }
      return { x: rat(v[0]), y: rat(v[1]) };
    });
    const poly = validatePolygon(vertices);
    this.#transact(() => { this.#tolerance = poly; });
    return { toleranceVertices: poly.vertices.length };
  }

  setCorrection(spec = {}) {
    const x = spec.x === undefined ? identityCoeffs() : parsePolynomial(spec.x, 'correction.x');
    const y = spec.y === undefined ? identityCoeffs() : parsePolynomial(spec.y, 'correction.y');
    const version = spec.version === undefined ? 'custom' : String(spec.version);
    this.#transact(() => { this.#correction = { version, x, y }; });
    return { version };
  }

  addPoint(spec = {}) {
    if (spec.id === undefined || spec.id === null) {
      throw new QError(E.VALIDATION, 'point requires an "id"');
    }
    const id = String(spec.id);
    if (this.#points.has(id)) throw new QError(E.VALIDATION, `duplicate point id "${id}"`);
    const parseInterval = (v, label) => {
      const pair = Array.isArray(v) ? v : [v, v];
      if (pair.length !== 2) throw new QError(E.INTERVAL, `${label} must be [lo, hi]`);
      const lo = rat(pair[0]);
      const hi = rat(pair[1]);
      if (lo.cmp(hi) > 0) {
        throw new QError(E.INTERVAL, `${label}: lower bound ${lo} exceeds upper bound ${hi}`);
      }
      return { lo, hi };
    };
    const x = parseInterval(spec.x, `point "${id}" x interval`);
    const y = parseInterval(spec.y, `point "${id}" y interval`);
    this.#transact(() => { this.#points.set(id, { id, x, y }); });
    return { id };
  }

  undo() {
    if (this.#past.length === 0) return { changed: false };
    this.#future.push(this.#snapshot());
    this.#restore(this.#past.pop());
    return { changed: true };
  }

  redo() {
    if (this.#future.length === 0) return { changed: false };
    this.#past.push(this.#snapshot());
    this.#restore(this.#future.pop());
    return { changed: true };
  }

  // ---- judgment ----------------------------------------------------------

  #recompute() {
    this.#judgments = new Map();
    for (const p of this.#points.values()) this.#judgments.set(p.id, this.#judge(p));
  }

  #judge(p) {
    const mx = mapInterval(this.#correction.x, p.x.lo, p.x.hi);
    const my = mapInterval(this.#correction.y, p.y.lo, p.y.hi);
    const box = { xmin: mx.min, xmax: mx.max, ymin: my.min, ymax: my.max };
    const j = {
      id: p.id,
      correctionVersion: this.#correction.version,
      box,
      stationary: { x: mx.stationary, y: my.stationary },
      classification: null,
      corners: null,
    };
    if (this.#tolerance) {
      const r = classifyBox(box, this.#tolerance);
      j.classification = r.classification;
      j.corners = r.corners;
    }
    return j;
  }

  judgment(id, decimals = 3) {
    const j = this.#judgments.get(String(id));
    if (!j) throw new QError(E.VALIDATION, `unknown point id "${id}"`);
    return this.#formatJudgment(j, decimals);
  }

  #formatJudgment(j, decimals) {
    assertDecimals(decimals);
    const fmt = (r) => formatScaledInt(roundToScaledInt(r, decimals), decimals);
    const out = {
      id: j.id,
      correctionVersion: j.correctionVersion,
      exact: {
        x: { min: j.box.xmin.toString(), max: j.box.xmax.toString() },
        y: { min: j.box.ymin.toString(), max: j.box.ymax.toString() },
      },
      display: {
        x: { min: fmt(j.box.xmin), max: fmt(j.box.xmax) },
        y: { min: fmt(j.box.ymin), max: fmt(j.box.ymax) },
      },
      rounding: { decimals, errorBound: roundingErrorBound(decimals).toString() },
      classification: j.classification,
    };
    const st = {};
    if (j.stationary.x) st.x = { t: j.stationary.x.t.toString(), value: j.stationary.x.value.toString() };
    if (j.stationary.y) st.y = { t: j.stationary.y.t.toString(), value: j.stationary.y.value.toString() };
    if (Object.keys(st).length > 0) out.stationaryPoints = st;
    if (j.corners) {
      out.corners = j.corners.map((c) => ({ x: c.x.toString(), y: c.y.toString(), position: c.position }));
    }
    return out;
  }

  state(decimals = 3) {
    assertDecimals(decimals);
    return {
      correctionVersion: this.#correction.version,
      tolerance: this.#tolerance
        ? { vertices: this.#tolerance.vertices.map((v) => [v.x.toString(), v.y.toString()]) }
        : null,
      points: [...this.#judgments.values()].map((j) => this.#formatJudgment(j, decimals)),
      canUndo: this.#past.length > 0,
      canRedo: this.#future.length > 0,
    };
  }
}
