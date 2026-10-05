import type { ClearingProblem } from "./clearing.js";

interface LocalBill {
  payer: number;
  payee: number;
  amount: bigint;
  penalty: bigint;
}

function localize(problem: ClearingProblem): {
  bills: LocalBill[];
  init: bigint[];
} {
  const index = new Map(problem.accounts.map((account, i) => [account, i]));
  return {
    bills: problem.bills.map((bill) => ({
      payer: index.get(bill.payer)!,
      payee: index.get(bill.payee)!,
      amount: bill.amount,
      penalty: bill.penalty,
    })),
    init: problem.accounts.map(
      (account) => problem.initialBalances.get(account) ?? 0n,
    ),
  };
}

export interface BruteForceResult {
  readonly minPenalty: bigint;
  readonly feasibleSubsetCount: number;
  readonly isFeasible: (mask: number) => boolean;
}

export function bruteForce(
  problem: ClearingProblem,
  maxBills = 10,
): BruteForceResult {
  const n = problem.bills.length;
  if (n > maxBills) {
    throw new Error(`bruteForce limited to ${maxBills} bills, got ${n}`);
  }
  const { bills, init } = localize(problem);
  const size = 1 << n;
  const feasibleTable = new Uint8Array(size);
  const penaltySum = new Array<bigint>(size).fill(0n);
  feasibleTable[0] = 1;

  const subsetFeasible = (indices: number[]): boolean => {
    const balances = init.slice();
    const used = new Array<boolean>(indices.length).fill(false);
    const dfs = (remaining: number): boolean => {
      if (remaining === 0) return true;
      for (let t = 0; t < indices.length; t++) {
        if (used[t]) continue;
        const bill = bills[indices[t]];
        if (balances[bill.payer] < bill.amount) continue;
        used[t] = true;
        balances[bill.payer] -= bill.amount;
        balances[bill.payee] += bill.amount;
        if (dfs(remaining - 1)) return true;
        balances[bill.payer] += bill.amount;
        balances[bill.payee] -= bill.amount;
        used[t] = false;
      }
      return false;
    };
    return dfs(indices.length);
  };

  let feasibleSubsetCount = 0;
  let bestAcceptedPenalty = 0n;
  let totalPenalty = 0n;
  for (const bill of bills) totalPenalty += bill.penalty;

  for (let mask = 1; mask < size; mask++) {
    const lowbit = mask & -mask;
    const bit = 31 - Math.clz32(lowbit);
    penaltySum[mask] = penaltySum[mask ^ lowbit] + bills[bit].penalty;
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) indices.push(i);
    }
    if (subsetFeasible(indices)) {
      feasibleTable[mask] = 1;
      feasibleSubsetCount++;
      if (penaltySum[mask] > bestAcceptedPenalty) {
        bestAcceptedPenalty = penaltySum[mask];
      }
    }
  }

  return {
    minPenalty: totalPenalty - bestAcceptedPenalty,
    feasibleSubsetCount: feasibleSubsetCount + 1,
    isFeasible: (mask: number) => feasibleTable[mask] === 1,
  };
}

export function forwardDpMinPenalty(problem: ClearingProblem): bigint {
  const { bills, init } = localize(problem);
  const n = bills.length;
  const size = 1 << n;
  const accountCount = init.length;

  const deltas: bigint[][] = new Array(size);
  const penaltySum = new Array<bigint>(size);
  deltas[0] = new Array<bigint>(accountCount).fill(0n);
  penaltySum[0] = 0n;
  for (let mask = 1; mask < size; mask++) {
    const lowbit = mask & -mask;
    const i = 31 - Math.clz32(lowbit);
    const prev = mask ^ lowbit;
    const delta = deltas[prev].slice();
    delta[bills[i].payer] -= bills[i].amount;
    delta[bills[i].payee] += bills[i].amount;
    deltas[mask] = delta;
    penaltySum[mask] = penaltySum[prev] + bills[i].penalty;
  }

  const reachable = new Uint8Array(size);
  reachable[0] = 1;
  let bestAcceptedPenalty = 0n;
  for (let mask = 0; mask < size; mask++) {
    if (reachable[mask] !== 1) continue;
    if (penaltySum[mask] > bestAcceptedPenalty) {
      bestAcceptedPenalty = penaltySum[mask];
    }
    for (let j = 0; j < n; j++) {
      if ((mask & (1 << j)) !== 0) continue;
      const bill = bills[j];
      if (init[bill.payer] + deltas[mask][bill.payer] >= bill.amount) {
        reachable[mask | (1 << j)] = 1;
      }
    }
  }

  let totalPenalty = 0n;
  for (const bill of bills) totalPenalty += bill.penalty;
  return totalPenalty - bestAcceptedPenalty;
}
