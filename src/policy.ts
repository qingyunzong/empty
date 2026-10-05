import { evalExpr, type Attrs, type Expr } from './expr.js';
import { T, type Tri } from './trilean.js';

export type Effect = 'permit' | 'deny';

export interface Rule {
  readonly id: string;
  readonly effect: Effect;
  readonly when: Expr;
}

export interface Policy {
  readonly id?: string;
  readonly rules: readonly Rule[];
}

export type Decision = 'permit' | 'deny';

export interface RuleResult {
  readonly id: string;
  readonly effect: Effect;
  readonly value: Tri;
}

export interface EvalResult {
  readonly decision: Decision;
  readonly ruleResults: readonly RuleResult[];
  /** Ids of a minimal set of rules whose results alone determine the decision. */
  readonly decisiveRuleIds: readonly string[];
}

/**
 * Decision aggregation:
 *  - any deny rule evaluating to true denies outright;
 *  - otherwise permit only if some permit rule evaluates to true
 *    (unknown or false permit results never allow);
 *  - otherwise default deny.
 */
export function decide(ruleResults: readonly RuleResult[]): Decision {
  if (ruleResults.some((r) => r.effect === 'deny' && r.value === T)) return 'deny';
  if (ruleResults.some((r) => r.effect === 'permit' && r.value === T)) return 'permit';
  return 'deny';
}

/**
 * Computes a minimal decisive rule set: a smallest set of rules whose
 * evaluation results, by themselves, fix the final decision no matter how
 * every other rule would evaluate (true / false / unknown).
 *
 * Reasoning:
 *  - A policy without permit rules can never permit: the empty set suffices.
 *  - A deny decision caused by a true deny rule is fixed by that rule alone.
 *  - A permit decision needs one true permit rule as witness plus every deny
 *    rule (each unchecked deny rule could have been true and flipped it).
 *  - A default-deny decision needs every permit rule checked (any unchecked
 *    permit rule could have been true), while deny rules are irrelevant.
 */
export function minimalDecisiveSet(
  rules: readonly Rule[],
  ruleResults: readonly RuleResult[],
  decision: Decision,
): string[] {
  const permitIds = rules.filter((r) => r.effect === 'permit').map((r) => r.id);
  if (permitIds.length === 0) return [];
  if (decision === 'deny') {
    const trueDeny = ruleResults.find((r) => r.effect === 'deny' && r.value === T);
    if (trueDeny) return [trueDeny.id];
    return [...permitIds];
  }
  const truePermit = ruleResults.find((r) => r.effect === 'permit' && r.value === T);
  const denyIds = rules.filter((r) => r.effect === 'deny').map((r) => r.id);
  return [truePermit!.id, ...denyIds];
}

/** Evaluates a policy against an attribute environment. */
export function evaluate(policy: Policy, attrs: Attrs): EvalResult {
  const ruleResults: RuleResult[] = policy.rules.map((rule) => ({
    id: rule.id,
    effect: rule.effect,
    value: evalExpr(rule.when, attrs),
  }));
  const decision = decide(ruleResults);
  return {
    decision,
    ruleResults,
    decisiveRuleIds: minimalDecisiveSet(policy.rules, ruleResults, decision),
  };
}
