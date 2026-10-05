import { readFileSync } from "node:fs";
import process from "node:process";
import {
  normalizeProblem,
  solve,
  verifyCertificate,
  type ClearingProblem,
  type ClearingSolution,
  type RawProblem,
} from "./clearing.js";
import { bruteForce, forwardDpMinPenalty } from "./verify.js";

function formatBalances(
  problem: ClearingProblem,
  balances: ReadonlyMap<string, bigint>,
): string {
  return problem.accounts
    .map((account) => `${account}=${balances.get(account)}`)
    .join("  ");
}

function printSolution(
  problem: ClearingProblem,
  solution: ClearingSolution,
): void {
  console.log("=== Clearing Solution ===");
  console.log(`bills: ${problem.bills.length}`);
  console.log(`minimum penalty: ${solution.minPenalty}`);
  console.log(
    `execution order: ${
      solution.executed.map((bill) => bill.id).join(" -> ") || "(none)"
    }`,
  );
  console.log(
    `rejected: ${
      solution.rejected
        .map((bill) => `${bill.id}(penalty ${bill.penalty})`)
        .join(", ") || "(none)"
    }`,
  );
  console.log("");
  console.log("=== Step-by-step Balance Certificate ===");
  console.log(`initial: ${formatBalances(problem, problem.initialBalances)}`);
  for (const step of solution.certificate) {
    const before = step.balancesBefore.get(step.payer)!;
    console.log(
      `step ${step.step}: ${step.billId}  ${step.payer} -> ${step.payee}` +
        `  amount=${step.amount}` +
        `  (payer ${before} >= ${step.amount}: OK)`,
    );
    console.log(`  after: ${formatBalances(problem, step.balancesAfter)}`);
  }
  console.log(`final: ${formatBalances(problem, solution.finalBalances)}`);
}

function main(): void {
  const path = process.argv[2] ?? "instances/sample.json";
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawProblem;
  const problem = normalizeProblem(raw);
  const solution = solve(problem);
  printSolution(problem, solution);

  console.log("");
  console.log("=== Verification ===");
  const certificate = verifyCertificate(problem, solution);
  console.log(
    `certificate replay: ${certificate.ok ? "PASS" : `FAIL (${certificate.reason})`}`,
  );
  const forward = forwardDpMinPenalty(problem);
  console.log(
    `forward-DP cross-check: ${forward === solution.minPenalty ? "PASS" : "FAIL"}` +
      ` (minPenalty=${forward})`,
  );
  if (problem.bills.length <= 10) {
    const brute = bruteForce(problem);
    console.log(
      `exhaustive subset x permutation check: ${
        brute.minPenalty === solution.minPenalty ? "PASS" : "FAIL"
      } (minPenalty=${brute.minPenalty}, feasible subsets=${brute.feasibleSubsetCount})`,
    );
  } else {
    console.log("exhaustive subset x permutation check: skipped (n > 10)");
  }
  if (!certificate.ok || forward !== solution.minPenalty) {
    process.exitCode = 1;
  }
}

main();
