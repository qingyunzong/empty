import type { Assignment, Condition, Effect, Policy, Rule } from "./types.js";

type Tri = true | false | "unknown";

function evalCondition(cond: Condition, assignment: Assignment): Tri {
  if (!assignment.has(cond.attr)) return "unknown";
  const actual = assignment.get(cond.attr)!;
  switch (cond.kind) {
    case "eq":
      return actual === cond.value;
    case "ne":
      return actual !== cond.value;
    case "in":
      return cond.values.includes(actual);
  }
}

/** Decision of a policy on a total assignment: first matching rule wins, else the default. */
export function decideTotal(policy: Policy, assignment: Assignment): Effect {
  for (const rule of policy.rules) {
    if (rule.conditions.every((c) => evalCondition(c, assignment) === true)) return rule.effect;
  }
  return policy.defaultEffect;
}

function walk(rules: Rule[], index: number, defaultEffect: Effect, assignment: Assignment, out: Set<Effect>): void {
  if (index >= rules.length) {
    out.add(defaultEffect);
    return;
  }
  const rule = rules[index]!;
  let hasUnknown = false;
  for (const cond of rule.conditions) {
    const tri = evalCondition(cond, assignment);
    if (tri === false) {
      walk(rules, index + 1, defaultEffect, assignment, out);
      return;
    }
    if (tri === "unknown") hasUnknown = true;
  }
  if (!hasUnknown) {
    out.add(rule.effect);
    return;
  }
  out.add(rule.effect);
  walk(rules, index + 1, defaultEffect, assignment, out);
}

/**
 * Set of decisions a policy can take over all total extensions of a (partial)
 * assignment. The assignment fully determines the policy iff this set is a singleton.
 */
export function possibleEffects(policy: Policy, assignment: Assignment): Set<Effect> {
  const out = new Set<Effect>();
  walk(policy.rules, 0, policy.defaultEffect, assignment, out);
  return out;
}

/** A partial assignment is a difference witness iff both policies are determined and disagree. */
export function isWitness(policies: [Policy, Policy], assignment: Assignment): false | [Effect, Effect] {
  const first = possibleEffects(policies[0], assignment);
  const second = possibleEffects(policies[1], assignment);
  if (first.size !== 1 || second.size !== 1) return false;
  const a = [...first][0]!;
  const b = [...second][0]!;
  return a === b ? false : [a, b];
}
