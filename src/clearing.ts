export interface Bill {
  readonly id: string;
  readonly payer: string;
  readonly payee: string;
  readonly amount: bigint;
  readonly penalty: bigint;
}

export interface ClearingProblem {
  readonly accounts: readonly string[];
  readonly initialBalances: ReadonlyMap<string, bigint>;
  readonly bills: readonly Bill[];
}

export interface RawBill {
  id: string;
  payer: string;
  payee: string;
  amount: bigint | number | string;
  penalty: bigint | number | string;
}

export interface RawProblem {
  initialBalances: Record<string, bigint | number | string>;
  bills: RawBill[];
}

export interface CertificateStep {
  readonly step: number;
  readonly billId: string;
  readonly payer: string;
  readonly payee: string;
  readonly amount: bigint;
  readonly balancesBefore: ReadonlyMap<string, bigint>;
  readonly balancesAfter: ReadonlyMap<string, bigint>;
}

export interface ClearingSolution {
  readonly minPenalty: bigint;
  readonly executed: readonly Bill[];
  readonly rejected: readonly Bill[];
  readonly certificate: readonly CertificateStep[];
  readonly finalBalances: ReadonlyMap<string, bigint>;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export const MAX_BILLS = 16;

function toBigInt(value: bigint | number | string, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} must be an integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${field} must be an integer, got ${JSON.stringify(value)}`);
}

export function normalizeProblem(raw: RawProblem): ClearingProblem {
  if (!raw || typeof raw !== "object") {
    throw new Error("problem must be an object");
  }
  const initialBalances = new Map<string, bigint>();
  for (const [account, value] of Object.entries(raw.initialBalances ?? {})) {
    initialBalances.set(account, toBigInt(value, `initialBalances.${account}`));
  }
  const seenIds = new Set<string>();
  const bills: Bill[] = (raw.bills ?? []).map((rawBill, i) => {
    const id = String(rawBill.id ?? "");
    if (!id) throw new Error(`bills[${i}].id must be a non-empty string`);
    if (seenIds.has(id)) throw new Error(`duplicate bill id: ${id}`);
    seenIds.add(id);
    const amount = toBigInt(rawBill.amount, `bills[${i}].amount`);
    const penalty = toBigInt(rawBill.penalty, `bills[${i}].penalty`);
    if (amount < 0n) throw new Error(`bills[${i}].amount must be >= 0`);
    if (penalty < 0n) throw new Error(`bills[${i}].penalty must be >= 0`);
    return {
      id,
      payer: String(rawBill.payer),
      payee: String(rawBill.payee),
      amount,
      penalty,
    };
  });
  if (bills.length > MAX_BILLS) {
    throw new Error(`at most ${MAX_BILLS} bills supported, got ${bills.length}`);
  }
  const accounts: string[] = [];
  const seenAccounts = new Set<string>();
  const addAccount = (account: string) => {
    if (!seenAccounts.has(account)) {
      seenAccounts.add(account);
      accounts.push(account);
    }
  };
  for (const account of initialBalances.keys()) addAccount(account);
  for (const bill of bills) {
    addAccount(bill.payer);
    addAccount(bill.payee);
  }
  for (const account of accounts) {
    if (!initialBalances.has(account)) initialBalances.set(account, 0n);
  }
  return { accounts, initialBalances, bills };
}

interface Compiled {
  readonly n: number;
  readonly payer: number[];
  readonly payee: number[];
  readonly amount: bigint[];
  readonly penalty: bigint[];
  readonly init: bigint[];
}

function compile(problem: ClearingProblem): Compiled {
  const index = new Map(problem.accounts.map((account, i) => [account, i]));
  const bills = problem.bills;
  return {
    n: bills.length,
    payer: bills.map((bill) => index.get(bill.payer)!),
    payee: bills.map((bill) => index.get(bill.payee)!),
    amount: bills.map((bill) => bill.amount),
    penalty: bills.map((bill) => bill.penalty),
    init: problem.accounts.map(
      (account) => problem.initialBalances.get(account) ?? 0n,
    ),
  };
}

function computeDeltas(compiled: Compiled): {
  deltas: bigint[][];
  penaltySum: bigint[];
} {
  const size = 1 << compiled.n;
  const accountCount = compiled.init.length;
  const deltas: bigint[][] = new Array(size);
  const penaltySum: bigint[] = new Array(size);
  deltas[0] = new Array<bigint>(accountCount).fill(0n);
  penaltySum[0] = 0n;
  for (let mask = 1; mask < size; mask++) {
    const lowbit = mask & -mask;
    const i = 31 - Math.clz32(lowbit);
    const prev = mask ^ lowbit;
    const delta = deltas[prev].slice();
    delta[compiled.payer[i]] -= compiled.amount[i];
    delta[compiled.payee[i]] += compiled.amount[i];
    deltas[mask] = delta;
    penaltySum[mask] = penaltySum[prev] + compiled.penalty[i];
  }
  return { deltas, penaltySum };
}

export function solve(problem: ClearingProblem): ClearingSolution {
  const compiled = compile(problem);
  const size = 1 << compiled.n;
  const { deltas, penaltySum } = computeDeltas(compiled);
  const feasible = new Uint8Array(size);
  const parent = new Int32Array(size).fill(-1);
  feasible[0] = 1;
  for (let mask = 1; mask < size; mask++) {
    let rest = mask;
    while (rest !== 0) {
      const lowbit = rest & -rest;
      const j = 31 - Math.clz32(lowbit);
      rest ^= lowbit;
      const prev = mask ^ lowbit;
      const payerBalance =
        compiled.init[compiled.payer[j]] + deltas[prev][compiled.payer[j]];
      if (feasible[prev] === 1 && payerBalance >= compiled.amount[j]) {
        feasible[mask] = 1;
        parent[mask] = j;
        break;
      }
    }
  }
  let bestMask = 0;
  for (let mask = 1; mask < size; mask++) {
    if (feasible[mask] === 1 && penaltySum[mask] > penaltySum[bestMask]) {
      bestMask = mask;
    }
  }
  const orderIndices: number[] = [];
  for (let mask = bestMask; mask !== 0; ) {
    const j = parent[mask];
    orderIndices.push(j);
    mask ^= 1 << j;
  }
  orderIndices.reverse();
  const executedSet = new Set(orderIndices);
  const executed = orderIndices.map((i) => problem.bills[i]);
  const rejected = problem.bills.filter((_, i) => !executedSet.has(i));
  const minPenalty = penaltySum[size - 1] - penaltySum[bestMask];
  const { certificate, finalBalances } = buildCertificate(problem, executed);
  return { minPenalty, executed, rejected, certificate, finalBalances };
}

function buildCertificate(
  problem: ClearingProblem,
  executed: readonly Bill[],
): { certificate: CertificateStep[]; finalBalances: Map<string, bigint> } {
  const balances = new Map(
    problem.accounts.map((account) => [
      account,
      problem.initialBalances.get(account) ?? 0n,
    ]),
  );
  const certificate: CertificateStep[] = [];
  executed.forEach((bill, index) => {
    const balancesBefore = new Map(balances);
    const payerBalance = balances.get(bill.payer)!;
    if (payerBalance < bill.amount) {
      throw new Error(`infeasible order produced at bill ${bill.id}`);
    }
    balances.set(bill.payer, payerBalance - bill.amount);
    balances.set(bill.payee, balances.get(bill.payee)! + bill.amount);
    certificate.push({
      step: index + 1,
      billId: bill.id,
      payer: bill.payer,
      payee: bill.payee,
      amount: bill.amount,
      balancesBefore,
      balancesAfter: new Map(balances),
    });
  });
  return { certificate, finalBalances: balances };
}

export function verifyCertificate(
  problem: ClearingProblem,
  solution: ClearingSolution,
): VerificationResult {
  const byId = new Map(problem.bills.map((bill) => [bill.id, bill]));
  const accounted = new Set<string>();
  for (const bill of solution.executed) {
    if (!byId.has(bill.id)) {
      return { ok: false, reason: `unknown executed bill ${bill.id}` };
    }
    if (accounted.has(bill.id)) {
      return { ok: false, reason: `bill ${bill.id} executed twice` };
    }
    accounted.add(bill.id);
  }
  let rejectedPenalty = 0n;
  for (const bill of solution.rejected) {
    if (!byId.has(bill.id)) {
      return { ok: false, reason: `unknown rejected bill ${bill.id}` };
    }
    if (accounted.has(bill.id)) {
      return { ok: false, reason: `bill ${bill.id} both executed and rejected` };
    }
    accounted.add(bill.id);
    rejectedPenalty += bill.penalty;
  }
  if (accounted.size !== problem.bills.length) {
    return { ok: false, reason: "not all bills are accounted for" };
  }
  if (rejectedPenalty !== solution.minPenalty) {
    return {
      ok: false,
      reason: `rejected penalties sum to ${rejectedPenalty}, claimed minPenalty ${solution.minPenalty}`,
    };
  }
  if (solution.certificate.length !== solution.executed.length) {
    return { ok: false, reason: "certificate length mismatch" };
  }
  const balances = new Map(
    problem.accounts.map((account) => [
      account,
      problem.initialBalances.get(account) ?? 0n,
    ]),
  );
  for (let s = 0; s < solution.executed.length; s++) {
    const bill = solution.executed[s];
    const step = solution.certificate[s];
    if (
      step.billId !== bill.id ||
      step.payer !== bill.payer ||
      step.payee !== bill.payee ||
      step.amount !== bill.amount
    ) {
      return {
        ok: false,
        reason: `certificate step ${s + 1} does not match executed bill ${bill.id}`,
      };
    }
    for (const [account, value] of balances) {
      if (step.balancesBefore.get(account) !== value) {
        return {
          ok: false,
          reason: `step ${s + 1}: balancesBefore mismatch for account ${account}`,
        };
      }
    }
    const payerBalance = balances.get(bill.payer)!;
    if (payerBalance < bill.amount) {
      return {
        ok: false,
        reason: `step ${s + 1}: insufficient balance for payer ${bill.payer}`,
      };
    }
    balances.set(bill.payer, payerBalance - bill.amount);
    balances.set(bill.payee, balances.get(bill.payee)! + bill.amount);
    for (const [account, value] of balances) {
      if (step.balancesAfter.get(account) !== value) {
        return {
          ok: false,
          reason: `step ${s + 1}: balancesAfter mismatch for account ${account}`,
        };
      }
    }
  }
  for (const [account, value] of balances) {
    if (solution.finalBalances.get(account) !== value) {
      return {
        ok: false,
        reason: `final balance mismatch for account ${account}`,
      };
    }
  }
  return { ok: true };
}
