import type { Verdict } from "./oracle.js";

export type OracleFn = (events: readonly string[]) => Verdict;

/**
 * Deterministically minimizes a failing event sequence by deleting
 * contiguous blocks (delta-debugging style, complements only).
 *
 * The loop only terminates after a full pass of single-event deletions
 * in which no deletion reproduces the failure, so the result is
 * guaranteed 1-minimal: removing any one event no longer fails.
 * "invalid" (illegal history) is never accepted as a failure.
 */
export function minimize(events: readonly string[], oracle: OracleFn): string[] {
  let current = events.slice();
  let granularity = 2;

  while (current.length > 1) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;

    for (let i = 0; i < granularity; i++) {
      const start = i * chunk;
      if (start >= current.length) break;
      const end = Math.min(start + chunk, current.length);
      const candidate = current.slice(0, start).concat(current.slice(end));
      if (candidate.length === 0 || candidate.length === current.length) continue;
      if (oracle(candidate) === "fail") {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }

    if (reduced) continue;
    if (chunk === 1) break; // every single-event deletion was tested: 1-minimal
    granularity = Math.min(current.length, granularity * 2);
  }

  return current;
}

export interface OneMinimalViolation {
  removedIndex: number;
  removedEvent: string;
  verdict: Verdict;
}

/**
 * Independently verifies 1-minimality: every single-event deletion
 * must not be a failure. Returns the list of violations (empty if ok).
 */
export function verifyOneMinimal(
  events: readonly string[],
  oracle: OracleFn,
  onCheck?: (removedIndex: number, removedEvent: string, verdict: Verdict) => void
): OneMinimalViolation[] {
  const violations: OneMinimalViolation[] = [];
  for (let i = 0; i < events.length; i++) {
    const candidate = events.slice(0, i).concat(events.slice(i + 1));
    const verdict = oracle(candidate);
    onCheck?.(i, events[i] as string, verdict);
    if (verdict === "fail") {
      violations.push({ removedIndex: i, removedEvent: events[i] as string, verdict });
    }
  }
  return violations;
}
