/**
 * Demo: evaluate a policy, then print its verified minimal rule set.
 * Run with: npm run demo
 */
import { and, eq, ge, not } from "../src/expr.js";
import { parseRational, rational } from "../src/rational.js";
import { decide, explain, formatPolicy, rule, type Policy } from "../src/policy.js";
import { minimizePolicy } from "../src/minimize.js";

const policy: Policy = {
  name: "document-access",
  rules: [
    rule("allow-staff", "allow", and(eq("role", "staff"), ge("clearance", rational(2n)))),
    rule(
      "allow-senior-staff",
      "allow",
      and(eq("role", "staff"), and(ge("clearance", rational(2n)), ge("tenure", rational(5n)))),
    ),
    rule("deny-high-risk", "deny", ge("risk", parseRational("4/5"))),
    rule("deny-suspended", "deny", eq("suspended", true)),
    rule("allow-never", "allow", and(eq("role", "staff"), not(eq("role", "staff")))),
  ],
};

console.log("== original policy ==");
console.log(formatPolicy(policy));

const request = { role: "staff", clearance: rational(3n), risk: parseRational("0.5") };
const x = explain(policy, request);
console.log("\n== decision for { role: 'staff', clearance: 3, risk: 1/2 } ==");
console.log(x.decision, "-", x.reason);
for (const r of x.ruleResults) console.log(`  ${r.effect.padEnd(5)} ${r.id}: ${r.result}`);

// Missing attributes -> unknown: suspended is absent, so its deny rule stays
// unknown and does not reject; the true allow rule grants.
console.log("\ndecide({ role: 'staff', clearance: 2 }) =", decide(policy, { role: "staff", clearance: rational(2n) }));

const res = minimizePolicy(policy);
console.log("\n== minimized rule set ==");
console.log(formatPolicy(res.policy));
console.log(`removed: [${res.removed.map((r) => r.id).join(", ")}]`);
console.log(`verified by exhaustive enumeration over ${res.assignmentsChecked} assignments: ${res.verified}`);
