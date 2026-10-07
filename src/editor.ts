import {
  Point,
  closestPointOnSegment,
  findSelfIntersection,
  roundPoint,
} from "./geometry";

/** A candidate wire: a polyline with a unique identifier. */
export interface Wire {
  id: number;
  /** At least two points; consecutive points form segments. */
  points: Point[];
}

/** One snap candidate: the closest spot on a wire to the drag target. */
export interface SnapCandidate {
  wireId: number;
  /** Index of the segment within the wire's polyline. */
  segmentIndex: number;
  /** Snapped integer position the vertex would move to. */
  point: Point;
  /** Squared distance from the drag target to the (unsnapped) closest point. */
  dist2: number;
}

export type RejectionCode = "SELF_INTERSECTION";

/** Why a candidate was refused, recorded for every rejected candidate. */
export interface CandidateRejection {
  candidate: SnapCandidate;
  code: RejectionCode;
  reason: string;
}

export interface DragSuccess {
  ok: true;
  vertexIndex: number;
  from: Point;
  to: Point;
  accepted: SnapCandidate;
  /** Candidates that ranked better but failed validation, in tried order. */
  rejected: CandidateRejection[];
}

export interface DragFailure {
  ok: false;
  vertexIndex: number;
  target: Point;
  reason: string;
  /** Every candidate that was considered and refused, in tried order. */
  rejected: CandidateRejection[];
}

export type DragResult = DragSuccess | DragFailure;

interface UndoEntry {
  vertexIndex: number;
  from: Point;
  to: Point;
}

export class Editor {
  /** Polygon vertices, always integer coordinates. */
  private vertices: Point[];
  private wires: Wire[];
  /** Maximum snap distance (same unit as coordinates). */
  private threshold: number;
  private history: UndoEntry[] = [];

  constructor(vertices: Point[], wires: Wire[], threshold: number) {
    if (vertices.length < 3) throw new Error("polygon needs at least 3 vertices");
    if (threshold < 0) throw new Error("threshold must be non-negative");
    for (const v of vertices) {
      if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) {
        throw new Error(`vertex (${v.x}, ${v.y}) is not an integer point`);
      }
    }
    for (const w of wires) {
      if (w.points.length < 2) throw new Error(`wire ${w.id} needs at least 2 points`);
    }
    this.vertices = vertices.map((p) => ({ ...p }));
    this.wires = wires.map((w) => ({ id: w.id, points: w.points.map((p) => ({ ...p })) }));
    this.threshold = threshold;
  }

  getVertices(): Point[] {
    return this.vertices.map((p) => ({ ...p }));
  }

  getVertex(index: number): Point {
    const v = this.vertices[index];
    if (!v) throw new RangeError(`vertex index ${index} out of range`);
    return { ...v };
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  /**
   * Ranked snap candidates for a drag target: every wire whose closest point
   * lies within the threshold, sorted by squared distance then wire id.
   */
  candidates(target: Point): SnapCandidate[] {
    const limit2 = this.threshold * this.threshold;
    const result: SnapCandidate[] = [];
    for (const wire of this.wires) {
      let best: SnapCandidate | null = null;
      for (let i = 0; i < wire.points.length - 1; i++) {
        const c = closestPointOnSegment(target, wire.points[i]!, wire.points[i + 1]!);
        if (c.dist2 <= limit2 && (best === null || c.dist2 < best.dist2)) {
          best = {
            wireId: wire.id,
            segmentIndex: i,
            point: roundPoint(c.point),
            dist2: c.dist2,
          };
        }
      }
      if (best) result.push(best);
    }
    result.sort((a, b) => a.dist2 - b.dist2 || a.wireId - b.wireId);
    return result;
  }

  /**
   * Drag vertex `vertexIndex` toward `target`. Candidates are tried in ranked
   * order; a candidate whose snapped position would self-intersect the polygon
   * is rejected (with a recorded reason) and the next one is tried. Exactly
   * one accepted move is applied per drag, so the whole drag is a single
   * undoable unit.
   */
  dragVertex(vertexIndex: number, target: Point): DragResult {
    const current = this.vertices[vertexIndex];
    if (!current) throw new RangeError(`vertex index ${vertexIndex} out of range`);

    const ranked = this.candidates(target);
    if (ranked.length === 0) {
      return {
        ok: false,
        vertexIndex,
        target: { ...target },
        reason: `no candidate wire within threshold ${this.threshold} of target (${target.x}, ${target.y})`,
        rejected: [],
      };
    }

    const rejected: CandidateRejection[] = [];
    for (const candidate of ranked) {
      const hit = findSelfIntersection(
        this.vertices.map((v, i) => (i === vertexIndex ? candidate.point : v)),
        vertexIndex,
      );
      if (hit) {
        rejected.push({
          candidate,
          code: "SELF_INTERSECTION",
          reason:
            `snapping to wire ${candidate.wireId} at (${candidate.point.x}, ${candidate.point.y})` +
            ` makes edge ${hit.movedEdge} cross edge ${hit.otherEdge}`,
        });
        continue;
      }
      const from = { ...current };
      this.vertices[vertexIndex] = { ...candidate.point };
      this.history.push({ vertexIndex, from, to: { ...candidate.point } });
      return {
        ok: true,
        vertexIndex,
        from,
        to: { ...candidate.point },
        accepted: candidate,
        rejected,
      };
    }

    return {
      ok: false,
      vertexIndex,
      target: { ...target },
      reason: `all ${ranked.length} candidate(s) rejected: ${rejected
        .map((r) => r.reason)
        .join("; ")}`,
      rejected,
    };
  }

  /** Undo the most recent successful drag. Returns false when nothing to undo. */
  undo(): boolean {
    const entry = this.history.pop();
    if (!entry) return false;
    this.vertices[entry.vertexIndex] = { ...entry.from };
    return true;
  }
}
