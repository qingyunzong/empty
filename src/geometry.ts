export interface Vec {
  readonly x: number;
  readonly y: number;
}

export function vec(x: number, y: number): Vec {
  return { x, y };
}

export function isIntegerVec(p: Vec): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y);
}

/** Signed area x2 of triangle (a, b, c); exact for integer inputs. */
export function orient(a: Vec, b: Vec, c: Vec): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Squared distance from point p to segment ab. */
export function distSqPointToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const ex = p.x - (a.x + t * dx);
  const ey = p.y - (a.y + t * dy);
  return ex * ex + ey * ey;
}

/** Closest point on segment ab to p (may be fractional). */
export function closestPointOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: a.x, y: a.y };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Round to the nearest integer grid point. */
export function snapToIntegers(p: Vec): Vec {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function onSegment(a: Vec, b: Vec, p: Vec): boolean {
  return (
    orient(a, b, p) === 0 &&
    Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y)
  );
}

/** Inclusive intersection test: crossing or touching counts. */
export function segmentsIntersect(p1: Vec, p2: Vec, p3: Vec, p4: Vec): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

export function hasDuplicateConsecutive(vertices: Vec[]): boolean {
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    if (a.x === b.x && a.y === b.y) return true;
  }
  return false;
}

/**
 * True when the closed polygon ring self-intersects or is degenerate.
 * Adjacent edges may share only their common endpoint; any other
 * intersection (crossing or touching) between non-adjacent edges counts.
 */
export function polygonSelfIntersects(vertices: Vec[]): boolean {
  const n = vertices.length;
  if (n < 3) return true;
  if (hasDuplicateConsecutive(vertices)) return true;
  for (let i = 0; i < n; i++) {
    const a1 = vertices[i];
    const a2 = vertices[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === (i + 1) % n || i === (j + 1) % n) continue; // adjacent edges
      const b1 = vertices[j];
      const b2 = vertices[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}
