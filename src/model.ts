export type Edge = 'left' | 'right' | 'top' | 'bottom';

export interface RectSpec {
  id: string;
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

export type AlignmentConstraint =
  | { kind: 'pair'; a: string; edgeA: Edge; b: string; edgeB: Edge }
  | { kind: 'fixed'; a: string; edgeA: Edge; value: number };

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Layout = Record<string, Placement>;

export interface Problem {
  /** Square grid side length; placements must satisfy 0 <= x, x + w <= grid (same for y). */
  grid: number;
  rects: RectSpec[];
  alignments: AlignmentConstraint[];
  oldLayout: Layout;
}

export function edgeValue(p: Placement, edge: Edge): number {
  switch (edge) {
    case 'left': return p.x;
    case 'right': return p.x + p.w;
    case 'top': return p.y;
    case 'bottom': return p.y + p.h;
  }
}

export function overlaps(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Total movement: sum of Manhattan distances of top-left corners vs. the old layout. */
export function moveDistance(problem: Problem, layout: Layout): number {
  let total = 0;
  for (const r of problem.rects) {
    const cur = layout[r.id];
    const old = problem.oldLayout[r.id];
    if (!cur || !old) throw new Error(`missing placement for rect ${r.id}`);
    total += Math.abs(cur.x - old.x) + Math.abs(cur.y - old.y);
  }
  return total;
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

/** Returns a list of human-readable violations; empty means the layout is fully feasible. */
export function validateLayout(problem: Problem, layout: Layout): string[] {
  const violations: string[] = [];
  const byId = new Map(problem.rects.map((r) => [r.id, r]));

  for (const r of problem.rects) {
    const p = layout[r.id];
    if (!p) {
      violations.push(`rect ${r.id}: missing placement`);
      continue;
    }
    if (!isInt(p.x) || !isInt(p.y) || !isInt(p.w) || !isInt(p.h)) {
      violations.push(`rect ${r.id}: non-integer placement ${JSON.stringify(p)}`);
    }
    if (p.w < r.minW || p.w > r.maxW || p.h < r.minH || p.h > r.maxH) {
      violations.push(
        `rect ${r.id}: size ${p.w}x${p.h} outside [${r.minW}..${r.maxW}]x[${r.minH}..${r.maxH}]`,
      );
    }
    if (p.x < 0 || p.y < 0 || p.x + p.w > problem.grid || p.y + p.h > problem.grid) {
      violations.push(
        `rect ${r.id}: placement (${p.x},${p.y}) ${p.w}x${p.h} escapes grid ${problem.grid}`,
      );
    }
  }

  for (let i = 0; i < problem.rects.length; i++) {
    for (let j = i + 1; j < problem.rects.length; j++) {
      const a = layout[problem.rects[i]!.id];
      const b = layout[problem.rects[j]!.id];
      if (a && b && overlaps(a, b)) {
        violations.push(`rects ${problem.rects[i]!.id} and ${problem.rects[j]!.id} overlap`);
      }
    }
  }

  for (const c of problem.alignments) {
    if (c.kind === 'pair') {
      if (!byId.has(c.a) || !byId.has(c.b)) {
        violations.push(`alignment references unknown rect (${c.a}, ${c.b})`);
        continue;
      }
      const pa = layout[c.a];
      const pb = layout[c.b];
      if (!pa || !pb) continue;
      if (edgeValue(pa, c.edgeA) !== edgeValue(pb, c.edgeB)) {
        violations.push(
          `alignment ${c.a}.${c.edgeA}=${edgeValue(pa, c.edgeA)} != ${c.b}.${c.edgeB}=${edgeValue(pb, c.edgeB)}`,
        );
      }
    } else {
      if (!byId.has(c.a)) {
        violations.push(`alignment references unknown rect (${c.a})`);
        continue;
      }
      const pa = layout[c.a];
      if (!pa) continue;
      if (edgeValue(pa, c.edgeA) !== c.value) {
        violations.push(`alignment ${c.a}.${c.edgeA}=${edgeValue(pa, c.edgeA)} != ${c.value}`);
      }
    }
  }

  return violations;
}
