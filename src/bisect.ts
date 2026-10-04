import { topoOrder } from './dag.js';
import type { BisectReport, Dag, Detector, QueryRecord, Status } from './types.js';

export interface BisectOptions {
  /** Maximum number of detector probes. Omit for unlimited. */
  budget?: number;
}

/**
 * Diagnoses a version DAG under a query budget.
 *
 * Versions are probed in topological order (parents first). Results may be
 * non-monotonic: a bad version's child can be good again, so children of bad
 * versions are still probed. A detector exception is recorded as 'pending'
 * and counted against the budget. When the budget is exhausted the remaining
 * versions are kept in `untested`, and every version whose boundary status
 * cannot be decided is listed in `candidates`.
 */
export async function bisectDag(
  dag: Dag,
  detect: Detector,
  options: BisectOptions = {},
): Promise<BisectReport> {
  const order = topoOrder(dag);
  const budget = options.budget ?? null;
  if (budget !== null && (!Number.isInteger(budget) || budget < 0)) {
    throw new Error('budget must be a non-negative integer');
  }

  const status = new Map<string, Status>();
  const queries: QueryRecord[] = [];
  const untested: string[] = [];

  for (const version of order) {
    if (budget !== null && queries.length >= budget) {
      untested.push(version);
      continue;
    }
    let result: Status;
    let error: string | undefined;
    try {
      const raw = await detect(version);
      if (raw === 'good' || raw === 'bad' || raw === 'pending') {
        result = raw;
      } else {
        result = 'pending';
        error = `invalid detector result: ${JSON.stringify(raw)}`;
      }
    } catch (cause) {
      result = 'pending';
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const record: QueryRecord = { seq: queries.length + 1, version, result };
    if (error !== undefined) record.error = error;
    queries.push(record);
    status.set(version, result);
  }

  const boundary: string[] = [];
  const pending: string[] = [];
  const candidates: string[] = [];
  for (const version of order) {
    const own = status.get(version);
    const parents = dag.parents[version] ?? [];
    if (own === 'pending') pending.push(version);
    if (own === 'good') continue;
    if (parents.some((p) => status.get(p) === 'bad')) continue;
    if (own === 'bad' && parents.every((p) => status.get(p) === 'good')) {
      boundary.push(version);
    } else {
      candidates.push(version);
    }
  }

  return {
    boundary,
    pending,
    untested,
    candidates,
    queries,
    budget,
    used: queries.length,
  };
}
