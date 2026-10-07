/**
 * Versioned polygon editor.
 *
 * Every accepted edit is validated in full (all-edge-pairs exact scan plus
 * containment) and published atomically as a new immutable version. A
 * rejected edit changes nothing. All previous versions remain readable.
 */

import { Point } from "./geometry";
import {
  Conflict,
  Polygon,
  getRing,
  ringCount,
  ringLabel,
  validatePolygon,
} from "./polygon";

export interface VertexRef {
  /** 0 = outer ring, k >= 1 = holes[k - 1]. */
  ring: number;
  index: number;
}

export interface VertexMove {
  target: VertexRef;
  to: Point;
}

export type MoveResult =
  | { ok: true; version: number; polygon: Polygon }
  | { ok: false; conflicts: Conflict[] };

export class PolygonValidationError extends Error {
  readonly conflicts: Conflict[];
  constructor(conflicts: Conflict[]) {
    super(
      `invalid polygon (${conflicts.length} conflict(s)):\n` +
        conflicts.map((c) => `  - ${c.message}`).join("\n"),
    );
    this.name = "PolygonValidationError";
    this.conflicts = conflicts;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value) as (keyof T)[]) {
      deepFreeze(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export class PolygonEditor {
  private readonly versions: Polygon[] = [];

  constructor(initial: Polygon) {
    const conflicts = validatePolygon(initial);
    if (conflicts.length > 0) throw new PolygonValidationError(conflicts);
    this.versions.push(deepFreeze(structuredClone(initial)));
  }

  /** Index of the current version (0-based); equals version count - 1. */
  get version(): number {
    return this.versions.length - 1;
  }

  /** Number of stored versions. */
  get versionCount(): number {
    return this.versions.length;
  }

  /** The current polygon (immutable snapshot). */
  get current(): Polygon {
    return this.versions[this.versions.length - 1]!;
  }

  /** Any previously published version stays readable. */
  getVersion(version: number): Polygon {
    if (!Number.isInteger(version) || version < 0 || version >= this.versions.length) {
      throw new RangeError(
        `version ${version} out of range [0, ${this.versions.length - 1}]`,
      );
    }
    return this.versions[version]!;
  }

  /** Convenience wrapper for a single-vertex move. */
  moveVertex(target: VertexRef, to: Point): MoveResult {
    return this.moveVertices([{ target, to }]);
  }

  /**
   * Batch move: every move is applied to a candidate copy, the candidate is
   * validated in full, and only then published as a new version. If any
   * conflict is found, nothing changes and the conflicts (with concrete
   * edge evidence) are returned.
   */
  moveVertices(moves: VertexMove[]): MoveResult {
    if (moves.length === 0) {
      throw new RangeError("batch must contain at least one move");
    }
    const seen = new Set<string>();
    for (const move of moves) {
      this.checkTarget(move.target);
      const key = `${move.target.ring}:${move.target.index}`;
      if (seen.has(key)) {
        throw new RangeError(
          `duplicate move target ${ringLabel(move.target.ring)} vertex ${move.target.index}`,
        );
      }
      seen.add(key);
    }

    const candidate = structuredClone(this.current) as Polygon;
    for (const move of moves) {
      getRing(candidate, move.target.ring)[move.target.index] = {
        x: move.to.x,
        y: move.to.y,
      };
    }

    const conflicts = validatePolygon(candidate);
    if (conflicts.length > 0) {
      return { ok: false, conflicts };
    }
    this.versions.push(deepFreeze(candidate));
    return { ok: true, version: this.version, polygon: candidate };
  }

  private checkTarget(target: VertexRef): void {
    const rings = ringCount(this.current);
    if (!Number.isInteger(target.ring) || target.ring < 0 || target.ring >= rings) {
      throw new RangeError(`ring ${target.ring} out of range [0, ${rings - 1}]`);
    }
    const n = getRing(this.current, target.ring).length;
    if (!Number.isInteger(target.index) || target.index < 0 || target.index >= n) {
      throw new RangeError(
        `${ringLabel(target.ring)} vertex index ${target.index} out of range [0, ${n - 1}]`,
      );
    }
  }
}
