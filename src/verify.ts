/**
 * Independent optimality check: exhaustively enumerates sample subsets by
 * increasing size (plain lexicographic combinations, pruned only by the sound
 * necessary condition "remaining samples can still complete the coverage")
 * and confirms that no subset smaller than the solver's answer covers every
 * distinguishable pair. Also counts how many subsets of the optimal size are
 * feasible, so alternative optima are visible.
 */
export interface VerifyResult {
  /** True when enumeration completed and confirmed minimality. */
  confirmed: boolean;
  /** A smaller feasible subset, if one was found (means the solver is wrong). */
  counterexample: number[] | null;
  /** Number of feasible subsets of exactly the optimal size. */
  optimalCount: number;
  /** Total combination nodes visited across all sizes. */
  nodesVisited: number;
  /** Largest subset size fully enumerated (should be optimalSize - 1 when confirmed). */
  maxSizeExhausted: number;
  /** True when the node budget stopped the enumeration early. */
  budgetExhausted: boolean;
}

export function verifyByEnumeration(
  sampleCover: bigint[],
  fullCover: bigint,
  optimalSize: number,
  nodeBudget: number
): VerifyResult {
  const sampleCount = sampleCover.length;
  const suffixOr = new Array<bigint>(sampleCount + 1).fill(0n);
  for (let i = sampleCount - 1; i >= 0; i--) {
    suffixOr[i] = suffixOr[i + 1]! | sampleCover[i]!;
  }

  let nodesVisited = 0;
  let budgetExhausted = false;
  let counterexample: number[] | null = null;
  let optimalCount = 0;
  let maxSizeExhausted = -1;

  const chosen: number[] = [];

  function enumerate(size: number, position: number, acc: bigint, collect: boolean): boolean {
    if (nodesVisited >= nodeBudget) {
      budgetExhausted = true;
      return false;
    }
    nodesVisited++;
    if (chosen.length === size) {
      if (acc === fullCover) {
        if (collect) {
          optimalCount++;
        } else if (counterexample === null) {
          counterexample = chosen.slice();
        }
      }
      return true;
    }
    const remainingSlots = size - chosen.length;
    if (sampleCount - position < remainingSlots) return true;
    if ((acc | suffixOr[position]!) !== fullCover) return true;
    for (let i = position; i <= sampleCount - remainingSlots; i++) {
      chosen.push(i);
      const ok = enumerate(size, i + 1, acc | sampleCover[i]!, collect);
      chosen.pop();
      if (!ok) return false;
    }
    return true;
  }

  for (let size = 0; size < optimalSize && !budgetExhausted; size++) {
    if (!enumerate(size, 0, 0n, false)) break;
    maxSizeExhausted = size;
  }

  if (!budgetExhausted && counterexample === null) {
    enumerate(optimalSize, 0, 0n, true);
  }

  return {
    confirmed: !budgetExhausted && counterexample === null && maxSizeExhausted === optimalSize - 1,
    counterexample,
    optimalCount,
    nodesVisited,
    maxSizeExhausted,
    budgetExhausted,
  };
}
