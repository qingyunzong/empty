/** Detection outcome for a single version. */
export type Status = 'good' | 'bad' | 'pending';

/**
 * Version DAG. `parents[v]` lists the direct parents of v.
 * Roots are nodes with no parents (missing entry means no parents).
 */
export interface Dag {
  nodes: string[];
  parents: Record<string, string[]>;
}

/**
 * Adapter that probes the actual good/bad state of a version.
 * May be async. Throwing (or returning 'pending') leaves the
 * version unresolved: the diagnosis treats it as pending.
 */
export type Detector = (version: string) => Status | Promise<Status>;

/** One recorded probe: the query evidence. */
export interface QueryRecord {
  seq: number;
  version: string;
  result: Status;
  error?: string;
}

export interface BisectReport {
  /** Confirmed boundary: tested bad while every parent tested good. */
  boundary: string[];
  /** Tested but unresolved (detector threw or returned 'pending'). */
  pending: string[];
  /** Not tested because the query budget ran out. */
  untested: string[];
  /**
   * Unresolved possible-boundary versions: not confirmed boundary and
   * not confirmed non-boundary (untested/pending, or parents unresolved).
   */
  candidates: string[];
  /** Every probe issued, in order. */
  queries: QueryRecord[];
  /** Query budget (null = unlimited) and how many probes were used. */
  budget: number | null;
  used: number;
}
