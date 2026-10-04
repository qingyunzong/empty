/**
 * Incremental anomaly-segment detector.
 *
 * Points (id, value) are kept in sorted order by (value, id). Between every
 * pair of adjacent points there is an edge; an edge is "anomalous" when the
 * value difference strictly exceeds the threshold. An anomaly segment is a
 * maximal run of consecutive anomalous edges; its members are the points the
 * run touches, and its segment id is the minimum member id.
 *
 * Inserting a point splits the old edge between its new neighbours into two
 * edges; deleting a point merges the two surrounding edges into one. Segment
 * membership is updated incrementally on every mutation.
 */

export interface Point {
  id: number;
  value: number;
}

export interface AnomalySegment {
  /** Minimum id among member points. */
  id: number;
  /** Member point ids in sorted (value, id) order. */
  members: number[];
}

class Segment {
  members: number[];

  constructor(members: number[]) {
    this.members = members;
  }
}

export class AnomalyDetector {
  private readonly threshold: number;
  private readonly values = new Map<number, number>();
  /** Point ids sorted by (value, id). */
  private order: number[] = [];
  /** Left point ids of anomalous edges. An edge is keyed by its left point. */
  private readonly anomalousEdges = new Set<number>();
  /** Left point id of an anomalous edge -> segment containing that edge. */
  private readonly edgeToSegment = new Map<number, Segment>();

  constructor(threshold: number) {
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new RangeError(`threshold must be a non-negative finite number, got ${threshold}`);
    }
    this.threshold = threshold;
  }

  get size(): number {
    return this.order.length;
  }

  has(id: number): boolean {
    return this.values.has(id);
  }

  insert(id: number, value: number): void {
    if (this.values.has(id)) {
      throw new Error(`duplicate point id ${id}`);
    }
    if (!Number.isFinite(value)) {
      throw new RangeError(`value must be finite, got ${value}`);
    }
    const pos = this.locate(id, value);
    const prev = pos > 0 ? this.order[pos - 1] : undefined;
    const next = pos < this.order.length ? this.order[pos] : undefined;
    // The new point splits the old edge (prev, next); drop it if anomalous.
    if (prev !== undefined && next !== undefined && this.anomalousEdges.has(prev)) {
      this.removeAnomalousEdge(prev);
    }
    this.values.set(id, value);
    this.order.splice(pos, 0, id);
    if (prev !== undefined) this.maybeAddEdge(prev, id);
    if (next !== undefined) this.maybeAddEdge(id, next);
  }

  delete(id: number): void {
    const value = this.values.get(id);
    if (value === undefined) {
      throw new Error(`unknown point id ${id}`);
    }
    const pos = this.locate(id, value);
    const prev = pos > 0 ? this.order[pos - 1] : undefined;
    const next = pos < this.order.length - 1 ? this.order[pos + 1] : undefined;
    if (prev !== undefined && this.anomalousEdges.has(prev)) {
      this.removeAnomalousEdge(prev);
    }
    if (next !== undefined && this.anomalousEdges.has(id)) {
      this.removeAnomalousEdge(id);
    }
    this.order.splice(pos, 1);
    this.values.delete(id);
    // Deletion merges the two neighbours into a new edge (prev, next).
    if (prev !== undefined && next !== undefined) {
      this.maybeAddEdge(prev, next);
    }
  }

  /** Current anomaly segments, sorted by segment id (min member id). */
  segments(): AnomalySegment[] {
    const seen = new Set<Segment>();
    const result: AnomalySegment[] = [];
    for (const segment of this.edgeToSegment.values()) {
      if (seen.has(segment)) continue;
      seen.add(segment);
      result.push({ id: Math.min(...segment.members), members: [...segment.members] });
    }
    result.sort((a, b) => a.id - b.id);
    return result;
  }

  /** Snapshot of all points, for differential checks against fullScan. */
  points(): Point[] {
    return this.order.map((id) => ({ id, value: this.values.get(id)! }));
  }

  /** Insertion position of (id, value) in the sorted order. */
  private locate(id: number, value: number): number {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const midId = this.order[mid]!;
      const midValue = this.values.get(midId)!;
      if (midValue < value || (midValue === value && midId < id)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private maybeAddEdge(leftId: number, rightId: number): void {
    const diff = this.values.get(rightId)! - this.values.get(leftId)!;
    if (diff > this.threshold) {
      this.addAnomalousEdge(leftId, rightId);
    }
  }

  private addAnomalousEdge(leftId: number, rightId: number): void {
    this.anomalousEdges.add(leftId);
    const pos = this.locate(leftId, this.values.get(leftId)!);
    const before = pos > 0 ? this.order[pos - 1] : undefined;
    const leftSegment = before !== undefined ? this.edgeToSegment.get(before) : undefined;
    const rightSegment = this.edgeToSegment.get(rightId);
    if (leftSegment !== undefined && rightSegment !== undefined) {
      // The new edge bridges two segments: merge them.
      leftSegment.members.push(...rightSegment.members);
      for (let i = 0; i < rightSegment.members.length - 1; i++) {
        this.edgeToSegment.set(rightSegment.members[i]!, leftSegment);
      }
      this.edgeToSegment.set(leftId, leftSegment);
    } else if (leftSegment !== undefined) {
      leftSegment.members.push(rightId);
      this.edgeToSegment.set(leftId, leftSegment);
    } else if (rightSegment !== undefined) {
      rightSegment.members.unshift(leftId);
      this.edgeToSegment.set(leftId, rightSegment);
    } else {
      this.edgeToSegment.set(leftId, new Segment([leftId, rightId]));
    }
  }

  private removeAnomalousEdge(leftId: number): void {
    this.anomalousEdges.delete(leftId);
    const segment = this.edgeToSegment.get(leftId);
    if (segment === undefined) return;
    const cut = segment.members.indexOf(leftId);
    for (let i = 0; i < segment.members.length - 1; i++) {
      this.edgeToSegment.delete(segment.members[i]!);
    }
    // Removing the edge splits the run into a left and a right part; each
    // part with at least two members (one edge) remains a segment.
    const leftMembers = segment.members.slice(0, cut + 1);
    const rightMembers = segment.members.slice(cut + 1);
    for (const part of [leftMembers, rightMembers]) {
      if (part.length < 2) continue;
      const next = new Segment(part);
      for (let i = 0; i < part.length - 1; i++) {
        this.edgeToSegment.set(part[i]!, next);
      }
    }
  }
}

/**
 * Reference implementation: recompute all segments from scratch with a full
 * edge scan. Used to cross-check the incremental detector.
 */
export function fullScan(points: readonly Point[], threshold: number): AnomalySegment[] {
  const sorted = [...points].sort((a, b) => a.value - b.value || a.id - b.id);
  const result: AnomalySegment[] = [];
  let current: number[] | null = null;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const anomalous = sorted[i + 1]!.value - sorted[i]!.value > threshold;
    if (anomalous) {
      if (current === null) {
        current = [sorted[i]!.id, sorted[i + 1]!.id];
      } else {
        current.push(sorted[i + 1]!.id);
      }
    } else if (current !== null) {
      result.push({ id: Math.min(...current), members: current });
      current = null;
    }
  }
  if (current !== null) {
    result.push({ id: Math.min(...current), members: current });
  }
  result.sort((a, b) => a.id - b.id);
  return result;
}
