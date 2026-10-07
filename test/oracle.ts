/**
 * Independent brute-force oracle used to cross-check the library.
 *
 * Written separately from src/: an O(n^2) all-edge-pairs exact scan with
 * BigInt arithmetic, plus a winding-number containment test (Sunday's
 * quadrant-free algorithm) that shares no code with the library's
 * ray-casting implementation.
 */

import { Point } from "../src/geometry";
import { Polygon } from "../src/polygon";

function cross(ax: number, ay: number, bx: number, by: number): bigint {
  return BigInt(ax) * BigInt(by) - BigInt(ay) * BigInt(bx);
}

function orient2(a: Point, b: Point, c: Point): bigint {
  return cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
}

function between(a: number, p: number, b: number): boolean {
  return Math.min(a, b) <= p && p <= Math.max(a, b);
}

function onSeg(a: Point, b: Point, p: Point): boolean {
  return (
    orient2(a, b, p) === 0n &&
    between(a.x, p.x, b.x) &&
    between(a.y, p.y, b.y)
  );
}

/** True when closed segments ab and cd meet in any way (touch included). */
export function oracleSegmentsMeet(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orient2(a, b, c);
  const o2 = orient2(a, b, d);
  const o3 = orient2(c, d, a);
  const o4 = orient2(c, d, b);
  if (o1 === 0n && o2 === 0n) {
    // Collinear: any shared point at all?
    return (
      onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b)
    );
  }
  const straddle1 = (o1 > 0n && o2 < 0n) || (o1 < 0n && o2 > 0n);
  const straddle2 = (o3 > 0n && o4 < 0n) || (o3 < 0n && o4 > 0n);
  if (straddle1 && straddle2) return true;
  return (
    (o1 === 0n && onSeg(a, b, c)) ||
    (o2 === 0n && onSeg(a, b, d)) ||
    (o3 === 0n && onSeg(c, d, a)) ||
    (o4 === 0n && onSeg(c, d, b))
  );
}

interface E {
  ring: number;
  edge: number;
  p: Point;
  q: Point;
}

function allEdges(poly: Polygon): E[] {
  const rings = [poly.outer, ...poly.holes];
  const out: E[] = [];
  rings.forEach((ring, r) => {
    ring.forEach((p, i) => {
      out.push({ ring: r, edge: i, p, q: ring[(i + 1) % ring.length]! });
    });
  });
  return out;
}

/** Canonical "ring.edge/ring.edge" keys of every meeting edge pair. */
export function oracleConflictingPairs(poly: Polygon): Set<string> {
  const edges = allEdges(poly);
  const pairs = new Set<string>();
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i]!;
      const b = edges[j]!;
      if (!oracleSegmentsMeet(a.p, a.q, b.p, b.q)) continue;
      if (a.ring === b.ring) {
        const n = a.ring === 0 ? poly.outer.length : poly.holes[a.ring - 1]!.length;
        const adjacent =
          (a.edge + 1) % n === b.edge || (b.edge + 1) % n === a.edge;
        if (adjacent) {
          // Adjacent edges are legal only when their entire intersection
          // is the single shared endpoint. Count the distinct endpoints of
          // either segment that lie on both segments.
          const sharedPoints = [a.p, a.q, b.p, b.q].filter(
            (p, idx, all) =>
              onSeg(a.p, a.q, p) &&
              onSeg(b.p, b.q, p) &&
              all.findIndex((q) => q.x === p.x && q.y === p.y) === idx,
          );
          if (sharedPoints.length <= 1) continue;
        }
      }
      pairs.add(`${a.ring}.${a.edge}/${b.ring}.${b.edge}`);
    }
  }
  return pairs;
}

/** Winding number of p w.r.t. ring (exact; p must not be on the boundary). */
export function oracleWinding(p: Point, ring: Point[]): number {
  let wn = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    if (a.y <= p.y) {
      if (b.y > p.y && orient2(a, b, p) > 0n) wn++;
    } else {
      if (b.y <= p.y && orient2(a, b, p) < 0n) wn--;
    }
  }
  return wn;
}

export interface OracleVerdict {
  structuralProblems: string[];
  pairs: Set<string>;
  holesOutsideOuter: number[];
  nestedHoles: Array<[number, number]>;
  valid: boolean;
}

/** Full independent verdict for a polygon. */
export function oracleVerdict(poly: Polygon): OracleVerdict {
  const structuralProblems: string[] = [];
  const rings = [poly.outer, ...poly.holes];
  rings.forEach((ring, r) => {
    ring.forEach((v, i) => {
      if (!Number.isSafeInteger(v.x) || !Number.isSafeInteger(v.y)) {
        structuralProblems.push(`ring${r} vertex${i} non-integer`);
      }
    });
    if (ring.length < 3) structuralProblems.push(`ring${r} too small`);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a.x === b.x && a.y === b.y) structuralProblems.push(`ring${r} zero edge ${i}`);
    }
  });

  const pairs = structuralProblems.length > 0 ? new Set<string>() : oracleConflictingPairs(poly);

  const holesOutsideOuter: number[] = [];
  const nestedHoles: Array<[number, number]> = [];
  if (structuralProblems.length === 0 && pairs.size === 0) {
    poly.holes.forEach((hole, h) => {
      const probe = hole[0]!;
      if (oracleWinding(probe, poly.outer) === 0) holesOutsideOuter.push(h);
      poly.holes.forEach((other, k) => {
        if (k !== h && oracleWinding(probe, other) !== 0) nestedHoles.push([h, k]);
      });
    });
  }

  const valid =
    structuralProblems.length === 0 &&
    pairs.size === 0 &&
    holesOutsideOuter.length === 0 &&
    nestedHoles.length === 0;
  return { structuralProblems, pairs, holesOutsideOuter, nestedHoles, valid };
}

/** Deterministic PRNG (mulberry32) for reproducible fuzz runs. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
