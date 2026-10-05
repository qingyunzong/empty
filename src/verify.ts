/**
 * Certificate verification: replay a plan action-by-action and check
 * applicability (preconditions, resources, mutex rejection), the goal,
 * and — via full BFS — minimality.
 */

import {
  Problem,
  applyAction,
  initialState,
  isGoal,
  stateKey,
} from "./model.js";
import { shortestPlan } from "./bfs.js";

export interface ReplayStep {
  action: string;
  bits: number;
  res: number[];
  key: string;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  steps: ReplayStep[];
  goalReached: boolean;
  /** Present only when goalReached: true iff no shorter plan exists. */
  minimal?: boolean;
  optimalLength?: number;
}

export function verifyCertificate(p: Problem, plan: number[]): VerifyResult {
  const steps: ReplayStep[] = [];
  let s = initialState(p);
  steps.push({ action: "<initial>", bits: s.bits, res: [...s.res], key: stateKey(s.bits, s.res) });
  for (let i = 0; i < plan.length; i++) {
    const idx = plan[i]!;
    const a = p.actions[idx];
    if (!a) {
      return { ok: false, error: `step ${i}: action index ${idx} out of range`, steps, goalReached: false };
    }
    const next = applyAction(p, s, a);
    if (!next) {
      return {
        ok: false,
        error: `step ${i}: action ${a.name} not applicable (preconditions, resources, or mutex effects)`,
        steps,
        goalReached: false,
      };
    }
    s = next;
    steps.push({ action: a.name, bits: s.bits, res: [...s.res], key: stateKey(s.bits, s.res) });
  }
  const goalReached = isGoal(p, s.bits);
  if (!goalReached) {
    return { ok: false, error: "plan does not reach the goal", steps, goalReached };
  }
  const opt = shortestPlan(p);
  const optimalLength = opt.goalDepth;
  const minimal = optimalLength !== null && plan.length === optimalLength;
  return {
    ok: minimal,
    ...(minimal ? {} : { error: `plan length ${plan.length} is not minimal (optimal ${optimalLength})` }),
    steps,
    goalReached,
    minimal,
    ...(optimalLength !== null ? { optimalLength } : {}),
  };
}
