/**
 * Operation ID: a Lamport-style (replica, counter) pair.
 * Element IDs are the string form of the insert op's ID and are never reused.
 */
export interface OpId {
  readonly replica: string;
  readonly counter: number;
}

/** Total order over operation IDs: counter first, then replica ID. */
export function compareOpIds(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return 0;
}

export function opIdToString(id: OpId): string {
  return `${id.replica}:${id.counter}`;
}

/** A replica's knowledge of the highest counter seen per replica. */
export type VersionVector = Record<string, number>;

/** True when `id` is causally dominated by (i.e. happened-before) the context. */
export function isCausallyDominated(id: OpId, context: VersionVector): boolean {
  return (context[id.replica] ?? 0) >= id.counter;
}

/** Component-wise max merge of two version vectors (commutative, idempotent). */
export function mergeVersionVectors(a: VersionVector, b: VersionVector): VersionVector {
  const out: VersionVector = { ...a };
  for (const [replica, counter] of Object.entries(b)) {
    out[replica] = Math.max(out[replica] ?? 0, counter);
  }
  return out;
}
