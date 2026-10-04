import { bisectDag } from './bisect.js';
import type { BisectReport, Dag, Detector, QueryRecord, Status } from './types.js';

export interface FullScan {
  /** Exact boundary computed by probing every version. */
  boundary: string[];
  /** Observed status of every version. */
  status: Record<string, Status>;
  /** Versions that stayed pending even under a full scan. */
  pending: string[];
  queries: QueryRecord[];
}

/** Probes every version (no budget) to obtain the ground-truth boundary. */
export async function fullDagScan(dag: Dag, detect: Detector): Promise<FullScan> {
  const report = await bisectDag(dag, detect);
  const status: Record<string, Status> = {};
  for (const q of report.queries) status[q.version] = q.result;
  return {
    boundary: report.boundary,
    status,
    pending: report.pending,
    queries: report.queries,
  };
}

export interface CrossCheck {
  ok: boolean;
  /** Confirmed by the budgeted run but absent from the full scan. */
  extra: string[];
  /**
   * In the full-scan boundary but neither confirmed nor flagged as an
   * unresolved candidate by the budgeted run (i.e. silently missed).
   */
  missing: string[];
  /** Full-scan boundary versions the budgeted run left as candidates. */
  explainedByCandidates: string[];
  /** Versions pending in the full scan: ground truth itself is unresolved. */
  pendingInFullScan: string[];
  summary: string;
}

/**
 * Cross-checks a budgeted report against a full-DAG scan. The budgeted
 * boundary must be a subset of the exact boundary, and every exact boundary
 * version must be either confirmed or listed among the run's candidates.
 */
export function crossCheck(report: BisectReport, exact: FullScan): CrossCheck {
  const exactSet = new Set(exact.boundary);
  const candidateSet = new Set(report.candidates);

  const extra = report.boundary.filter((v) => !exactSet.has(v));
  const missing: string[] = [];
  const explainedByCandidates: string[] = [];
  for (const v of exact.boundary) {
    if (report.boundary.includes(v)) continue;
    if (candidateSet.has(v)) explainedByCandidates.push(v);
    else missing.push(v);
  }

  const ok = extra.length === 0 && missing.length === 0;
  const summary = ok
    ? `ok: confirmed boundary [${report.boundary.join(', ')}] is consistent ` +
      `with full-DAG scan (${exact.boundary.length} exact, ` +
      `${explainedByCandidates.length} still candidate, ` +
      `${exact.pending.length} pending in full scan)`
    : `MISMATCH: extra=[${extra.join(', ')}] missing=[${missing.join(', ')}]`;

  return {
    ok,
    extra,
    missing,
    explainedByCandidates,
    pendingInFullScan: exact.pending,
    summary,
  };
}
