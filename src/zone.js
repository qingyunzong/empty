import { ZoneError } from './errors.js';
import {
  parsePoint, sub, cross, validatePolygon, orientationOf, segSegDist2, pointToJSON,
} from './geometry.js';

/**
 * Convex polygon safety zone with transactional vertex edits and undo/redo.
 * All coordinates are exact rationals (Frac); no floats or square roots.
 */
export class SafeZone {
  #vertices = [];
  #orient = 1;
  #undo = [];
  #redo = [];

  constructor(vertices) {
    if (vertices !== undefined) this.init(vertices);
  }

  /** Replace the polygon and clear all history. */
  init(rawVertices) {
    const vs = rawVertices.map(parsePoint);
    const orient = validatePolygon(vs);
    this.#vertices = vs;
    this.#orient = orient;
    this.#undo = [];
    this.#redo = [];
    return this.state();
  }

  /** Validate candidate; commit only on success (transactional rollback on throw). */
  #commit(next) {
    const orient = validatePolygon(next); // throws -> state untouched
    this.#undo.push(this.#vertices);
    this.#redo = [];
    this.#vertices = next;
    this.#orient = orient;
  }

  #checkIndex(index, allowEnd) {
    const max = allowEnd ? this.#vertices.length : this.#vertices.length - 1;
    if (!Number.isInteger(index) || index < 0 || index > max) {
      throw new ZoneError('E_INDEX', `vertex index ${index} out of range [0, ${max}]`);
    }
    return index;
  }

  addVertex(index, rawPoint) {
    const p = parsePoint(rawPoint);
    const next = this.#vertices.slice();
    const at = index === undefined || index === null ? next.length : this.#checkIndex(index, true);
    next.splice(at, 0, p);
    this.#commit(next);
    return this.state();
  }

  updateVertex(index, rawPoint) {
    const p = parsePoint(rawPoint);
    const at = this.#checkIndex(index, false);
    const next = this.#vertices.slice();
    next[at] = p;
    this.#commit(next);
    return this.state();
  }

  removeVertex(index) {
    const at = this.#checkIndex(index, false);
    const next = this.#vertices.slice();
    next.splice(at, 1);
    this.#commit(next);
    return this.state();
  }

  undo() {
    if (this.#undo.length === 0) return { changed: false, state: this.state() };
    this.#redo.push(this.#vertices);
    this.#vertices = this.#undo.pop();
    this.#orient = orientationOf(this.#vertices);
    return { changed: true, state: this.state() };
  }

  redo() {
    if (this.#redo.length === 0) return { changed: false, state: this.state() };
    this.#undo.push(this.#vertices);
    this.#vertices = this.#redo.pop();
    this.#orient = orientationOf(this.#vertices);
    return { changed: true, state: this.state() };
  }

  state() {
    return {
      vertices: this.#vertices.map(pointToJSON),
      vertexCount: this.#vertices.length,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
    };
  }

  /**
   * Classify segment {p, q} against the zone and compute the exact minimum
   * squared gap to all edges plus a verifiable certificate.
   * classification: 'inside' | 'touching' | 'outside'
   */
  query(segment) {
    if (this.#vertices.length < 3) throw new ZoneError('E_EMPTY', 'no polygon committed');
    if (!segment || typeof segment !== 'object') throw new ZoneError('E_INPUT', 'segment {p, q} required');
    const p = parsePoint(segment.p);
    const q = parsePoint(segment.q);
    const vs = this.#vertices;
    const n = vs.length;
    const orient = this.#orient;

    const side = (pt) => {
      let allIn = true, strict = true;
      for (let i = 0; i < n; i++) {
        const c = cross(sub(vs[(i + 1) % n], vs[i]), sub(pt, vs[i])).sign() * orient;
        if (c < 0) allIn = false;
        if (c <= 0) strict = false;
      }
      return { allIn, strict };
    };
    const sp = side(p);
    const sq = side(q);
    let classification;
    if (sp.allIn && sq.allIn) classification = sp.strict && sq.strict ? 'inside' : 'touching';
    else classification = 'outside';

    let best = null;
    const gaps = [];
    for (let i = 0; i < n; i++) {
      const a = vs[i], b = vs[(i + 1) % n];
      const r = segSegDist2(p, q, a, b);
      gaps.push(r.d2.toString());
      if (!best || r.d2.lt(best.d2)) best = { ...r, edge: i };
    }
    const a = vs[best.edge];
    const b = vs[(best.edge + 1) % n];
    const dq = sub(q, p);
    const de = sub(b, a);
    const pointOnSegment = { x: p.x.add(dq.x.mul(best.t1)), y: p.y.add(dq.y.mul(best.t1)) };
    const pointOnEdge = { x: a.x.add(de.x.mul(best.t2)), y: a.y.add(de.y.mul(best.t2)) };

    return {
      classification,
      minGapSquared: best.d2.toString(),
      nearestEdge: best.edge,
      certificate: {
        nearestEdge: best.edge,
        edge: { a: pointToJSON(a), b: pointToJSON(b) },
        segmentParam: best.t1.toString(),
        edgeParam: best.t2.toString(),
        pointOnSegment: pointToJSON(pointOnSegment),
        pointOnEdge: pointToJSON(pointOnEdge),
        minGapSquared: best.d2.toString(),
        allEdgeGapsSquared: gaps,
        method: 'exact rational segment-to-edge distance; minGapSquared = min(allEdgeGapsSquared), attained at nearestEdge with the given projection parameters',
      },
    };
  }
}
