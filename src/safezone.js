import { SafeZoneError, fail, toErrorResult } from './errors.js';
import { Fraction } from './fraction.js';
import {
  point,
  pointsEqual,
  dist2,
  validatePolygon,
  classifyPoint,
  segmentSegmentDistance2,
} from './geometry.js';

export function parsePoint(value) {
  try {
    if (Array.isArray(value)) {
      if (value.length !== 2) {
        throw new SafeZoneError('E_PARSE', `point array must be [x, y], got length ${value.length}`);
      }
      return point(value[0], value[1]);
    }
    if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value) {
      return point(value.x, value.y);
    }
    throw new SafeZoneError('E_PARSE', `invalid point: ${JSON.stringify(value)}`);
  } catch (e) {
    if (e instanceof SafeZoneError) throw e;
    throw new SafeZoneError('E_PARSE', `invalid point: ${String(value)}`);
  }
}

export function pointToJSON(p) {
  return { x: p.x.toString(), y: p.y.toString() };
}

function applyOp(work, op) {
  if (typeof op !== 'object' || op === null || typeof op.op !== 'string') {
    throw new SafeZoneError('E_PARSE', `invalid op: ${JSON.stringify(op)}`);
  }
  const next = work.slice();
  switch (op.op) {
    case 'addVertex': {
      const p = parsePoint(op.point);
      const index = op.index === undefined ? next.length : op.index;
      if (!Number.isInteger(index) || index < 0 || index > next.length) {
        throw new SafeZoneError('E_INDEX', `addVertex index ${index} out of range [0, ${next.length}]`);
      }
      next.splice(index, 0, p);
      return next;
    }
    case 'updateVertex': {
      const p = parsePoint(op.point);
      const { index } = op;
      if (!Number.isInteger(index) || index < 0 || index >= next.length) {
        throw new SafeZoneError('E_INDEX', `updateVertex index ${index} out of range [0, ${next.length - 1}]`);
      }
      next[index] = p;
      return next;
    }
    case 'removeVertex': {
      const { index } = op;
      if (!Number.isInteger(index) || index < 0 || index >= next.length) {
        throw new SafeZoneError('E_INDEX', `removeVertex index ${index} out of range [0, ${next.length - 1}]`);
      }
      next.splice(index, 1);
      return next;
    }
    default:
      throw new SafeZoneError('E_PARSE', `unknown op: ${op.op}`);
  }
}

/**
 * Analyze a query segment against a validated convex polygon.
 * All arithmetic is exact rational arithmetic (BigInt fractions).
 */
export function analyzeSegmentOnPolygon(vertices, orientation, a, b) {
  const ca = classifyPoint(vertices, orientation, a);
  const cb = classifyPoint(vertices, orientation, b);

  let status;
  if (ca.classification === 'outside' || cb.classification === 'outside') {
    status = 'outside'; // segment pokes out of the safety zone
  } else if (ca.classification === 'boundary' || cb.classification === 'boundary') {
    status = 'touching'; // fully inside the closed zone, touches the boundary
  } else {
    status = 'inside';
  }

  const n = vertices.length;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const c = vertices[i];
    const d = vertices[(i + 1) % n];
    const r = segmentSegmentDistance2(a, b, c, d);
    edges.push({
      index: i,
      from: c,
      to: d,
      gapSquared: r.d2,
      pointOnSegment: r.pOnAB,
      pointOnEdge: r.pOnCD,
      tSegment: r.tAB,
      tEdge: r.tCD,
    });
  }
  let best = edges[0];
  for (const e of edges) {
    if (e.gapSquared.lt(best.gapSquared)) best = e;
  }

  const certificate = {
    polygonOrientation: orientation === 1 ? 'ccw' : 'cw',
    degenerateSegment: pointsEqual(a, b),
    endpoints: [
      { point: a, classification: ca.classification, edgeSigns: ca.edgeSigns },
      { point: b, classification: cb.classification, edgeSigns: cb.edgeSigns },
    ],
    edges: edges.map((e) => ({
      index: e.index,
      gapSquared: e.gapSquared,
      pointOnSegment: e.pointOnSegment,
      pointOnEdge: e.pointOnEdge,
      tSegment: e.tSegment,
      tEdge: e.tEdge,
    })),
    checks: {
      allGapsNonNegative: edges.every((e) => e.gapSquared.sign() >= 0),
      minIsMinimal: edges.every((e) => e.gapSquared.ge(best.gapSquared)),
      projectionConsistent: dist2(best.pointOnSegment, best.pointOnEdge).eq(best.gapSquared),
      endpointsInsideOrOnBoundary: status !== 'outside',
      gapZeroIffBoundaryContact:
        best.gapSquared.isZero() ===
        (status === 'touching' ||
          (status === 'outside' &&
            edges.some((e) => e.gapSquared.isZero()))),
    },
  };

  return {
    status,
    degenerate: pointsEqual(a, b),
    gapSquared: best.gapSquared,
    nearestEdge: { index: best.index, from: best.from, to: best.to },
    pointOnSegment: best.pointOnSegment,
    pointOnEdge: best.pointOnEdge,
    tSegment: best.tSegment,
    tEdge: best.tEdge,
    certificate,
  };
}

export function analysisToJSON(r) {
  return {
    status: r.status,
    degenerate: r.degenerate,
    gapSquared: r.gapSquared.toString(),
    nearestEdge: {
      index: r.nearestEdge.index,
      from: pointToJSON(r.nearestEdge.from),
      to: pointToJSON(r.nearestEdge.to),
    },
    pointOnSegment: pointToJSON(r.pointOnSegment),
    pointOnEdge: pointToJSON(r.pointOnEdge),
    tSegment: r.tSegment.toString(),
    tEdge: r.tEdge.toString(),
    certificate: {
      polygonOrientation: r.certificate.polygonOrientation,
      degenerateSegment: r.certificate.degenerateSegment,
      endpoints: r.certificate.endpoints.map((e) => ({
        point: pointToJSON(e.point),
        classification: e.classification,
        edgeSigns: e.edgeSigns,
      })),
      edges: r.certificate.edges.map((e) => ({
        index: e.index,
        gapSquared: e.gapSquared.toString(),
        pointOnSegment: pointToJSON(e.pointOnSegment),
        pointOnEdge: pointToJSON(e.pointOnEdge),
        tSegment: e.tSegment.toString(),
        tEdge: e.tEdge.toString(),
      })),
      checks: r.certificate.checks,
    },
  };
}

/**
 * Convex safety zone with transactional incremental edits and undo/redo.
 * Every mutation is a transaction: if the resulting polygon is non-convex,
 * self-intersecting, has duplicate points, or has too few vertices, the
 * whole transaction rolls back and undo/redo history is left untouched.
 */
export class SafeZone {
  #versions = [];
  #cursor = -1;

  constructor(vertices = []) {
    if (vertices.length > 0) {
      const parsed = vertices.map(parsePoint);
      const v = validatePolygon(parsed);
      if (!v.ok) {
        throw new SafeZoneError(v.error.code, v.error.message);
      }
      this.#commit(parsed);
    }
  }

  #commit(verts) {
    this.#versions.length = this.#cursor + 1; // drop redo tail
    this.#versions.push(Object.freeze(verts.slice()));
    this.#cursor += 1;
  }

  get vertices() {
    if (this.#cursor < 0) return [];
    return this.#versions[this.#cursor].map((p) => ({ x: p.x, y: p.y }));
  }

  get version() {
    return this.#cursor;
  }

  get canUndo() {
    return this.#cursor > 0;
  }

  get canRedo() {
    return this.#cursor >= 0 && this.#cursor < this.#versions.length - 1;
  }

  /**
   * Apply a batch of vertex ops atomically. On any failure the zone is
   * left completely unchanged (including undo/redo stacks).
   */
  transact(ops) {
    if (!Array.isArray(ops) || ops.length === 0) {
      return fail('E_PARSE', 'transact expects a non-empty array of ops');
    }
    try {
      let work = this.vertices;
      for (const op of ops) {
        work = applyOp(work, op);
      }
      const v = validatePolygon(work);
      if (!v.ok) return v;
      this.#commit(work);
      return { ok: true, version: this.#cursor, vertices: work };
    } catch (e) {
      return toErrorResult(e);
    }
  }

  addVertex(p, index) {
    return this.transact([{ op: 'addVertex', point: p, index }]);
  }

  updateVertex(index, p) {
    return this.transact([{ op: 'updateVertex', index, point: p }]);
  }

  removeVertex(index) {
    return this.transact([{ op: 'removeVertex', index }]);
  }

  undo() {
    if (!this.canUndo) {
      return fail('E_UNDO', 'nothing to undo');
    }
    this.#cursor -= 1;
    return { ok: true, version: this.#cursor, vertices: this.vertices };
  }

  redo() {
    if (!this.canRedo) {
      return fail('E_UNDO', 'nothing to redo');
    }
    this.#cursor += 1;
    return { ok: true, version: this.#cursor, vertices: this.vertices };
  }

  analyzeSegment(pa, pb) {
    try {
      const a = parsePoint(pa);
      const b = parsePoint(pb);
      const verts = this.vertices;
      if (verts.length < 3) {
        return fail('E_EMPTY', `polygon needs at least 3 vertices, got ${verts.length}`);
      }
      const v = validatePolygon(verts);
      if (!v.ok) return v;
      return { ok: true, ...analyzeSegmentOnPolygon(verts, v.orientation, a, b) };
    } catch (e) {
      return toErrorResult(e);
    }
  }
}
