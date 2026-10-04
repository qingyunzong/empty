/**
 * Independent optimality check. This module deliberately shares no search
 * code with the solver: it recomputes the minimum covering size by plainly
 * enumerating every subset of columns of size 0, 1, 2, ... until a covering
 * subset appears. If the enumeration budget is exhausted first, the check is
 * reported as inconclusive instead of guessing.
 */

export type VerificationStatus = "confirmed" | "inconclusive" | "mismatch";

export interface VerificationResult {
  method: "independent-subset-enumeration";
  status: VerificationStatus;
  /** Minimum size found by plain enumeration (null when inconclusive). */
  enumeratedMinimumSize: number | null;
  /** Size claimed by the primary solver. */
  claimedSize: number;
  combinationsChecked: number;
  combinationLimit: number;
}

export const DEFAULT_COMBINATION_LIMIT = 2_000_000;

export function verifyByEnumeration(
  columnMasks: bigint[],
  fullMask: bigint,
  claimedSize: number,
  combinationLimit: number = DEFAULT_COMBINATION_LIMIT
): VerificationResult {
  const columnCount = columnMasks.length;
  let checked = 0;
  let enumeratedMinimum: number | null = null;

  const chosen: number[] = [];
  let stop = false;

  function covers(): boolean {
    let mask = 0n;
    for (const index of chosen) {
      mask |= columnMasks[index]!;
    }
    return mask === fullMask;
  }

  function enumerate(start: number, size: number): boolean {
    if (stop) {
      return false;
    }
    if (chosen.length === size) {
      checked += 1;
      if (checked > combinationLimit) {
        stop = true;
        return false;
      }
      return covers();
    }
    for (let i = start; i < columnCount; i += 1) {
      chosen.push(i);
      const hit = enumerate(i + 1, size);
      chosen.pop();
      if (hit || stop) {
        return hit;
      }
    }
    return false;
  }

  for (let size = 0; size <= columnCount && !stop; size += 1) {
    if (enumerate(0, size)) {
      enumeratedMinimum = size;
      break;
    }
  }

  let status: VerificationStatus;
  if (enumeratedMinimum === null) {
    status = stop ? "inconclusive" : "mismatch"; // no cover exists only if input was inconsistent
  } else {
    status = enumeratedMinimum === claimedSize ? "confirmed" : "mismatch";
  }

  return {
    method: "independent-subset-enumeration",
    status,
    enumeratedMinimumSize: enumeratedMinimum,
    claimedSize,
    combinationsChecked: checked,
    combinationLimit,
  };
}
