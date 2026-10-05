import {
  edgeValue,
  moveDistance,
  overlaps,
  validateLayout,
  type Layout,
  type Problem,
} from './model.js';
import type { SolveResult, SolveStatus } from './solver.js';

export interface ConstraintCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Certificate {
  problem: { grid: number; rects: number; alignments: number };
  status: SolveStatus;
  /** Certified lower bound on the optimal total movement (null if unknown/infeasible). */
  lowerBound: number | null;
  /** Certified upper bound = cost of the returned layout (null if no layout found). */
  upperBound: number | null;
  /** upperBound - lowerBound when both are known. */
  gap: number | null;
  layout: Layout | null;
  /** Per-constraint verification of `layout`. */
  checks: ConstraintCheck[];
  nodesExpanded: number;
}

/** Build a certificate from a solve result, with one explicit check per constraint. */
export function buildCertificate(problem: Problem, result: SolveResult): Certificate {
  const checks: ConstraintCheck[] = [];
  const layout = result.layout;

  if (layout) {
    for (const r of problem.rects) {
      const p = layout[r.id]!;
      const sizeOk = p.w >= r.minW && p.w <= r.maxW && p.h >= r.minH && p.h <= r.maxH;
      checks.push({
        name: `size-range:${r.id}`,
        ok: sizeOk,
        detail: `${p.w}x${p.h} in [${r.minW}..${r.maxW}]x[${r.minH}..${r.maxH}]`,
      });
      const inGrid =
        Number.isInteger(p.x) && Number.isInteger(p.y) &&
        p.x >= 0 && p.y >= 0 && p.x + p.w <= problem.grid && p.y + p.h <= problem.grid;
      checks.push({
        name: `grid-bounds:${r.id}`,
        ok: inGrid,
        detail: `(${p.x},${p.y}) ${p.w}x${p.h} within grid ${problem.grid}`,
      });
    }
    for (let i = 0; i < problem.rects.length; i++) {
      for (let j = i + 1; j < problem.rects.length; j++) {
        const a = layout[problem.rects[i]!.id]!;
        const b = layout[problem.rects[j]!.id]!;
        checks.push({
          name: `non-overlap:${problem.rects[i]!.id}~${problem.rects[j]!.id}`,
          ok: !overlaps(a, b),
          detail: `${problem.rects[i]!.id}@${a.x},${a.y} ${a.w}x${a.h} vs ${problem.rects[j]!.id}@${b.x},${b.y} ${b.w}x${b.h}`,
        });
      }
    }
    for (const [k, c] of problem.alignments.entries()) {
      if (c.kind === 'pair') {
        const va = edgeValue(layout[c.a]!, c.edgeA);
        const vb = edgeValue(layout[c.b]!, c.edgeB);
        checks.push({
          name: `alignment#${k}:${c.a}.${c.edgeA}=${c.b}.${c.edgeB}`,
          ok: va === vb,
          detail: `${va} vs ${vb}`,
        });
      } else {
        const va = edgeValue(layout[c.a]!, c.edgeA);
        checks.push({
          name: `alignment#${k}:${c.a}.${c.edgeA}=${c.value}`,
          ok: va === c.value,
          detail: `${va} vs ${c.value}`,
        });
      }
    }
  }

  const upper = result.objective;
  const lower = result.lowerBound;
  return {
    problem: {
      grid: problem.grid,
      rects: problem.rects.length,
      alignments: problem.alignments.length,
    },
    status: result.status,
    lowerBound: lower,
    upperBound: upper,
    gap: upper !== null && lower !== null ? upper - lower : null,
    layout,
    checks,
    nodesExpanded: result.nodesExpanded,
  };
}

/**
 * Independently re-verify a certificate against its problem.
 * Returns a list of issues; empty means the certificate is internally consistent.
 */
export function verifyCertificate(problem: Problem, cert: Certificate): string[] {
  const issues: string[] = [];

  for (const check of cert.checks) {
    if (!check.ok) issues.push(`failed constraint check: ${check.name} (${check.detail})`);
  }

  if (cert.layout !== null) {
    const violations = validateLayout(problem, cert.layout);
    issues.push(...violations.map((v) => `layout invalid: ${v}`));
    if (violations.length === 0) {
      const cost = moveDistance(problem, cert.layout);
      if (cert.upperBound !== cost) {
        issues.push(`upperBound ${cert.upperBound} != recomputed layout cost ${cost}`);
      }
    }
  } else if (cert.upperBound !== null) {
    issues.push('certificate has an upperBound but no layout');
  }

  if (cert.lowerBound !== null && cert.upperBound !== null && cert.lowerBound > cert.upperBound) {
    issues.push(`lowerBound ${cert.lowerBound} exceeds upperBound ${cert.upperBound}`);
  }
  if (
    cert.gap !== null &&
    cert.lowerBound !== null &&
    cert.upperBound !== null &&
    cert.gap !== cert.upperBound - cert.lowerBound
  ) {
    issues.push(`gap ${cert.gap} != upperBound - lowerBound`);
  }
  if (cert.status === 'optimal') {
    if (cert.layout === null) issues.push('status optimal but no layout');
    if (cert.lowerBound === null || cert.lowerBound !== cert.upperBound) {
      issues.push(`status optimal requires lowerBound == upperBound, got ${cert.lowerBound} vs ${cert.upperBound}`);
    }
  }
  if (cert.status === 'infeasible' && cert.layout !== null) {
    issues.push('status infeasible but a layout is present');
  }
  return issues;
}
