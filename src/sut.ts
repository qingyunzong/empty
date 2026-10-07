/**
 * System under test: an asynchronous job queue with cancellation.
 *
 * Jobs settle through the plan-controlled scheduler, so all asynchronous
 * behaviour is deterministic for a given (ops, plan) pair.
 */

export type JobStatus = 'pending' | 'done' | 'cancelled';

export interface JobView {
  id: string;
  name: string;
  status: JobStatus;
}

export interface QueueSnapshot {
  /** Jobs sorted by numeric id suffix — the canonical state. */
  jobs: JobView[];
  /** Jobs still unsettled. Unfinished work is observable, never a failure. */
  pending: number;
}

export interface JobQueue {
  submit(name: string): string;
  cancel(id: string): boolean;
  status(id: string): JobStatus | 'missing';
  snapshot(): QueueSnapshot;
  /** Return and clear events emitted since the last drain. */
  drainEvents(): string[];
}

export type Op =
  | { kind: 'submit'; name: string }
  | { kind: 'cancel'; id: string }
  | { kind: 'status'; id: string }
  | { kind: 'tick' };

/** Compare job ids by their numeric suffix (j2 < j10). */
export function compareJobIds(a: string, b: string): number {
  const na = Number(a.replace(/^\D+/, ''));
  const nb = Number(b.replace(/^\D+/, ''));
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic JSON: object keys sorted, array order preserved. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
    return out;
  }
  return value;
}
