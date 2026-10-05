/**
 * Policy evaluation with default-deny, three-valued semantics.
 *
 * Decision procedure for a request (attribute bag):
 *   1. If ANY deny rule's condition evaluates to true  -> deny (deny overrides).
 *   2. Else if ANY allow rule's condition evaluates to true -> allow.
 *   3. Otherwise -> deny (default deny).
 *
 * Consequences of the three-valued logic:
 *   - Only a definitively-true allow rule grants access ("最终仅真允许").
 *   - A deny rule evaluating to "unknown" (e.g. missing attribute) does NOT
 *     by itself cause a denial ("未知拒绝不自动拒绝"); the request may still
 *     be allowed by a true allow rule, or fall through to default deny.
 */

import { evalExpr, formatExpr, type Attrs, type Expr } from "./expr.js";
import type { TVL } from "./tvl.js";

export type Effect = "allow" | "deny";

export interface Rule {
  readonly id: string;
  readonly effect: Effect;
  readonly when: Expr;
}

export interface Policy {
  readonly name?: string;
  readonly rules: readonly Rule[];
}

export const rule = (id: string, effect: Effect, when: Expr): Rule => ({ id, effect, when });

export type Decision = "allow" | "deny";

export interface RuleResult {
  readonly id: string;
  readonly effect: Effect;
  readonly result: TVL;
}

export interface Explanation {
  readonly decision: Decision;
  readonly ruleResults: readonly RuleResult[];
  readonly reason: string;
}

export function evaluateRule(r: Rule, attrs: Attrs): TVL {
  return evalExpr(r.when, attrs);
}

export function explain(policy: Policy, attrs: Attrs): Explanation {
  const ruleResults = policy.rules.map((r) => ({
    id: r.id,
    effect: r.effect,
    result: evaluateRule(r, attrs),
  }));
  if (ruleResults.some((r) => r.effect === "deny" && r.result === "true")) {
    return { decision: "deny", ruleResults, reason: "a deny rule evaluated to true" };
  }
  if (ruleResults.some((r) => r.effect === "allow" && r.result === "true")) {
    return { decision: "allow", ruleResults, reason: "an allow rule evaluated to true" };
  }
  return {
    decision: "deny",
    ruleResults,
    reason: "no rule evaluated to true (default deny; unknown does not grant)",
  };
}

export function decide(policy: Policy, attrs: Attrs): Decision {
  return explain(policy, attrs).decision;
}

export function formatPolicy(policy: Policy): string {
  const lines = policy.rules.map(
    (r) => `${r.effect.toUpperCase().padEnd(5)} ${r.id}: ${formatExpr(r.when)}`,
  );
  return (policy.name ? `policy ${policy.name}:\n` : "policy:\n") + lines.join("\n");
}
