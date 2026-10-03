import { Rational } from './rational.js';
import { Interval } from './interval.js';
import { Polynomial } from './polynomial.js';
import { parsePoint, assertConvexPolygon, classifyBox, analyzeBox } from './geometry.js';
import { assertPrecision, roundToString, roundingErrorBound } from './rounding.js';
import { qerror } from './errors.js';

const IDENTITY = Object.freeze({ x: new Polynomial(['0', '1']), y: new Polynomial(['0', '1']) });

export class Inspector {
  constructor({ polygon, precision = 3 } = {}) {
    this.precision = assertPrecision(precision);
    if (!polygon) throw qerror('E_GEOMETRY', 'a tolerance polygon is required');
    this.vertices = Object.freeze(polygon.map(parsePoint));
    assertConvexPolygon(this.vertices);
    this.corrections = new Map(); // version -> {x: Polynomial, y: Polynomial}
    this.activeVersion = null; // null means identity correction
    this.points = new Map(); // id -> {id, x: Interval, y: Interval, judgment}
    this.undoStack = [];
    this.redoStack = [];
  }

  _activeCorrection() {
    if (this.activeVersion === null) return IDENTITY;
    const c = this.corrections.get(this.activeVersion);
    if (!c) throw qerror('E_CORRECTION', `unknown correction version ${this.activeVersion}`);
    return c;
  }

  _serialize() {
    return {
      activeVersion: this.activeVersion,
      corrections: [...this.corrections.entries()].map(([v, c]) => [
        v,
        { x: c.x.coeffs.map(String), y: c.y.coeffs.map(String) },
      ]),
      points: [...this.points.values()].map((p) => ({
        id: p.id,
        x: { lo: p.x.lo.toString(), hi: p.x.hi.toString() },
        y: { lo: p.y.lo.toString(), hi: p.y.hi.toString() },
      })),
    };
  }

  _restore(snap) {
    this.activeVersion = snap.activeVersion;
    this.corrections = new Map(
      snap.corrections.map(([v, c]) => [v, { x: new Polynomial(c.x), y: new Polynomial(c.y) }])
    );
    this.points = new Map();
    for (const p of snap.points) {
      const point = { id: p.id, x: new Interval(p.x.lo, p.x.hi), y: new Interval(p.y.lo, p.y.hi) };
      point.judgment = this._judge(point);
      this.points.set(p.id, point);
    }
  }

  _transact(fn) {
    const snap = this._serialize();
    try {
      const result = fn();
      this.undoStack.push(snap);
      this.redoStack = [];
      return result;
    } catch (e) {
      this._restore(snap);
      throw e;
    }
  }

  _judge(point) {
    const corr = this._activeCorrection();
    const box = { x: corr.x.mapInterval(point.x), y: corr.y.mapInterval(point.y) };
    return { status: classifyBox(box, this.vertices), box };
  }

  _rejudgeAll() {
    for (const p of this.points.values()) {
      p.judgment = this._judge(p);
    }
  }

  defineCorrection(version, def) {
    if (typeof version !== 'string' || version === '') {
      throw qerror('E_CORRECTION', 'correction version must be a non-empty string');
    }
    return this._transact(() => {
      if (!def || typeof def !== 'object') {
        throw qerror('E_CORRECTION', 'correction definition must provide x and y polynomials');
      }
      const px = new Polynomial(def.x);
      const py = new Polynomial(def.y);
      this.corrections.set(version, { x: px, y: py });
      return { version, defined: true };
    });
  }

  useCorrection(version) {
    return this._transact(() => {
      if (!this.corrections.has(version)) {
        throw qerror('E_CORRECTION', `unknown correction version ${JSON.stringify(version)}`);
      }
      this.activeVersion = version;
      this._rejudgeAll();
      return { version, active: true };
    });
  }

  addPoint(id, x, y) {
    if (typeof id !== 'string' || id === '') {
      throw qerror('E_POINT', 'point id must be a non-empty string');
    }
    return this._transact(() => {
      if (this.points.has(id)) {
        throw qerror('E_POINT', `duplicate point id ${JSON.stringify(id)}`);
      }
      if (!Array.isArray(x) || x.length !== 2 || !Array.isArray(y) || y.length !== 2) {
        throw qerror('E_INTERVAL', 'point intervals must be [lo, hi] pairs');
      }
      const point = { id, x: new Interval(x[0], x[1]), y: new Interval(y[0], y[1]) };
      point.judgment = this._judge(point);
      this.points.set(id, point);
      return { id, judgment: this.formatJudgment(point.judgment) };
    });
  }

  getJudgment(id) {
    const p = this.points.get(id);
    if (!p) throw qerror('E_POINT', `unknown point id ${JSON.stringify(id)}`);
    return this.formatJudgment(p.judgment);
  }

  undo() {
    if (this.undoStack.length === 0) return { changed: false };
    this.redoStack.push(this._serialize());
    this._restore(this.undoStack.pop());
    return { changed: true };
  }

  redo() {
    if (this.redoStack.length === 0) return { changed: false };
    this.undoStack.push(this._serialize());
    this._restore(this.redoStack.pop());
    return { changed: true };
  }

  formatJudgment(judgment) {
    const k = this.precision;
    const fmt = (iv) => ({
      exact: { lo: iv.lo.toString(), hi: iv.hi.toString() },
      display: { lo: roundToString(iv.lo, k), hi: roundToString(iv.hi, k) },
    });
    return {
      status: judgment.status,
      box: { x: fmt(judgment.box.x), y: fmt(judgment.box.y) },
      rounding: {
        precision: k,
        errorBound: roundingErrorBound(k).toString(),
      },
    };
  }

  analyze(id) {
    const p = this.points.get(id);
    if (!p) throw qerror('E_POINT', `unknown point id ${JSON.stringify(id)}`);
    return analyzeBox(p.judgment.box, this.vertices);
  }
}
