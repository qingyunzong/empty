import {
  Vec,
  closestPointOnSegment,
  distSqPointToSegment,
  hasDuplicateConsecutive,
  isIntegerVec,
  polygonSelfIntersects,
  snapToIntegers,
} from "./geometry";

export interface Shape {
  id: string;
  vertices: Vec[];
}

export interface Wire {
  id: string;
  a: Vec;
  b: Vec;
}

export interface CandidateAttempt {
  wireId: string;
  distanceSquared: number;
  snap: Vec;
  accepted: boolean;
  reason?: string;
}

export interface DragResult {
  applied: boolean;
  shapeId: string;
  vertexIndex: number;
  target: Vec;
  wireId?: string;
  snappedTo?: Vec;
  attempts: CandidateAttempt[];
  reasons: string[];
}

interface UndoEntry {
  shapeId: string;
  vertexIndex: number;
  previous: Vec;
  result: DragResult;
}

/**
 * Scene editor. Shapes are closed polygons with integer vertices; every
 * edge of a shape is a wire named "<shapeId>:e<i>". A drag snaps one
 * vertex to the best legal wire and is recorded as a single undoable unit.
 */
export class Editor {
  private shapes = new Map<string, Vec[]>();
  private undoStack: UndoEntry[] = [];

  constructor(private readonly threshold: number) {
    if (!(threshold >= 0)) throw new Error("threshold must be non-negative");
  }

  addShape(shape: Shape): void {
    if (this.shapes.has(shape.id)) {
      throw new Error(`duplicate shape id: ${shape.id}`);
    }
    if (shape.vertices.length < 3) {
      throw new Error(`shape ${shape.id}: needs at least 3 vertices`);
    }
    for (const v of shape.vertices) {
      if (!isIntegerVec(v)) {
        throw new Error(`shape ${shape.id}: non-integer vertex (${v.x}, ${v.y})`);
      }
    }
    if (polygonSelfIntersects(shape.vertices)) {
      throw new Error(`shape ${shape.id}: self-intersecting or degenerate`);
    }
    this.shapes.set(shape.id, shape.vertices.map((v) => ({ x: v.x, y: v.y })));
  }

  getVertices(shapeId: string): Vec[] {
    const verts = this.shapes.get(shapeId);
    if (!verts) throw new Error(`shape not found: ${shapeId}`);
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }

  /** All wires in the scene, optionally excluding one shape's own edges. */
  listWires(excludeShapeId?: string): Wire[] {
    const wires: Wire[] = [];
    for (const [shapeId, verts] of this.shapes) {
      if (shapeId === excludeShapeId) continue;
      for (let i = 0; i < verts.length; i++) {
        wires.push({
          id: `${shapeId}:e${i}`,
          a: verts[i],
          b: verts[(i + 1) % verts.length],
        });
      }
    }
    return wires;
  }

  /**
   * Drag one vertex toward `target`. Candidate wires are the edges of all
   * other shapes within `threshold` of the target, ordered by squared
   * distance then wire id. Each candidate is tried in order: the vertex is
   * snapped to the nearest integer point on the wire, and the snap is
   * rejected if it leaves the edited shape degenerate or self-intersecting.
   * The first legal candidate wins; the whole drag is one undoable step.
   */
  dragVertex(shapeId: string, vertexIndex: number, target: Vec): DragResult {
    const attempts: CandidateAttempt[] = [];
    const reasons: string[] = [];
    const fail = (reason: string): DragResult => {
      reasons.push(reason);
      return { applied: false, shapeId, vertexIndex, target, attempts, reasons };
    };

    const verts = this.shapes.get(shapeId);
    if (!verts) return fail(`shape not found: ${shapeId}`);
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= verts.length) {
      return fail(`vertex index out of range: ${vertexIndex}`);
    }
    if (!isIntegerVec(target)) {
      return fail(`target must have integer coordinates, got (${target.x}, ${target.y})`);
    }

    const thresholdSq = this.threshold * this.threshold;
    const candidates = this.listWires(shapeId)
      .map((wire) => ({ wire, d2: distSqPointToSegment(target, wire.a, wire.b) }))
      .filter((c) => c.d2 <= thresholdSq)
      .sort(
        (a, b) =>
          a.d2 - b.d2 || (a.wire.id < b.wire.id ? -1 : a.wire.id > b.wire.id ? 1 : 0),
      );

    if (candidates.length === 0) {
      return fail(
        `no candidate wire within threshold ${this.threshold} of (${target.x}, ${target.y})`,
      );
    }

    const previous = { ...verts[vertexIndex] };
    for (const { wire, d2 } of candidates) {
      const snap = snapToIntegers(closestPointOnSegment(target, wire.a, wire.b));
      verts[vertexIndex] = snap;
      const rejection = Editor.validate(verts);
      if (rejection !== null) {
        attempts.push({ wireId: wire.id, distanceSquared: d2, snap, accepted: false, reason: rejection });
        reasons.push(`candidate ${wire.id} rejected: ${rejection}`);
        continue;
      }
      attempts.push({ wireId: wire.id, distanceSquared: d2, snap, accepted: true });
      const result: DragResult = {
        applied: true,
        shapeId,
        vertexIndex,
        target,
        wireId: wire.id,
        snappedTo: snap,
        attempts,
        reasons,
      };
      this.undoStack.push({ shapeId, vertexIndex, previous, result });
      return result;
    }

    verts[vertexIndex] = previous;
    reasons.push(`all ${candidates.length} candidate(s) rejected; drag not applied`);
    return { applied: false, shapeId, vertexIndex, target, attempts, reasons };
  }

  /** Undo the most recent applied drag; returns its result, or undefined. */
  undo(): DragResult | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return undefined;
    const verts = this.shapes.get(entry.shapeId);
    if (verts) verts[entry.vertexIndex] = entry.previous;
    return entry.result;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  private static validate(verts: Vec[]): string | null {
    if (hasDuplicateConsecutive(verts)) {
      return "degenerate: snap creates a zero-length edge";
    }
    if (polygonSelfIntersects(verts)) {
      return "self-intersection after snap";
    }
    return null;
  }
}
