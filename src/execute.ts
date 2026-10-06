import type { Evidence, Plan, PlanStep, Resource } from "./types.js";
import { verifyPlan } from "./verify.js";

export type StepHandler = (step: PlanStep, resources: Map<string, Resource>) => unknown;

export type ExecuteResult =
  | { executed: true; results: unknown[] }
  | { executed: false; reason: string };

/**
 * Verification-gated execution. The plan is re-verified against the
 * evidence and resources first; if any field was tampered with, no
 * handler runs and nothing happens — failed verification never
 * produces side effects.
 */
export function executePlan(
  plan: Plan,
  evidence: Evidence,
  resources: Resource[],
  handlers: Record<string, StepHandler>,
): ExecuteResult {
  const verdict = verifyPlan(plan, evidence, resources);
  if (!verdict.ok) {
    return { executed: false, reason: verdict.reason };
  }
  const byId = new Map(resources.map((r) => [r.id, r]));
  const results: unknown[] = [];
  for (const step of plan.steps) {
    const handler = handlers[step.action.kind];
    if (handler === undefined) {
      return { executed: false, reason: `no handler for action kind "${step.action.kind}"` };
    }
    results.push(handler(step, byId));
  }
  return { executed: true, results };
}
