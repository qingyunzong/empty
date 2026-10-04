import { createSession, type SolveResult } from "./session.js";
import type { MarketInput } from "./types.js";

const market: MarketInput = {
  applicants: [
    { id: "a01", categories: ["phy"], prefers: [["X"], ["Y"]] },
    { id: "a02", categories: ["sci"], prefers: [["X", "Y"]] },
    { id: "a03", categories: ["art"], prefers: [["X"], ["Y"]] },
    { id: "a04", categories: ["sci", "art"], prefers: [["Y"], ["X"]] },
    { id: "a05", categories: [], prefers: [["X"], ["Y"]] },
    { id: "a06", categories: ["art"], prefers: [["Y"]] },
  ],
  institutions: [
    {
      id: "X",
      capacity: 3,
      quotas: [
        { id: "sci", quota: 2, children: [{ id: "phy", quota: 1 }] },
        { id: "art", quota: 2 },
      ],
      prefers: [["a03", "a01"], ["a02"], ["a04", "a05"], ["a06"]],
    },
    {
      id: "Y",
      capacity: 2,
      quotas: [{ id: "art", quota: 1 }],
      prefers: [["a04"], ["a02"], ["a01"], ["a06"], ["a03", "a05"]],
    },
  ],
};

function printResult(title: string, result: SolveResult): void {
  console.log(`=== ${title} ===`);
  console.log("matching:", JSON.stringify(result.matching));
  console.log("unassigned:", JSON.stringify(result.certificate.unassigned));
  console.log("admits:", JSON.stringify(result.certificate.admits));
  console.log("feasible:", result.certificate.feasible, "stable:", result.certificate.stable);
  console.log(`no-blocking-pair certificate: ${result.certificate.checks.length} critical pair(s) exhaustively checked`);
  for (const check of result.certificate.checks) {
    const verdict = check.blocking === null ? "no improving replacement" : `BLOCKS via replacing [${check.blocking.replaced.join(", ")}]`;
    console.log(
      `  (${check.applicant} -> ${check.institution}, current=${check.currentInstitution ?? "none"}): ` +
        `${check.replacementSetsExamined} replacement set(s) examined, ${verdict}`,
    );
  }
  if (result.enumeration !== undefined) {
    console.log(
      `exhaustive enumeration: ${result.enumeration.feasibleCount} feasible assignment(s), ` +
        `${result.enumeration.stableMatchings.length} stable, algorithm result in stable set: ` +
        `${result.enumeration.algorithmMatchingInStableSet}`,
    );
  }
  console.log();
}

const session = createSession(market);
printResult("initial market", session.solve({ enumerate: true }));

session.withdrawApplication("a01", "X");
console.log(">> a01 withdraws the application to X, recomputing");
printResult("after withdrawal", session.solve({ enumerate: true }));

session.withdrawApplicant("a03");
console.log(">> a03 leaves the market, recomputing");
printResult("after a03 leaves", session.solve({ enumerate: true }));
