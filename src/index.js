import { parseDfa, parseBudget } from "./dfa.js";
import { compareDfas } from "./equivalence.js";
import { buildTasks, minCostCover } from "./tasks.js";
import { buildPlan } from "./plan.js";

export class InfeasibleError extends Error {
  constructor(minCost, budget) {
    super(`minimum cover cost ${minCost} exceeds budget ${budget}`);
    this.name = "InfeasibleError";
    this.minCost = minCost;
    this.budget = budget;
  }
}

export function analyze(oldRaw, newRaw, budgetRaw, options = {}) {
  const oldDfa = parseDfa(oldRaw, "old");
  const newDfa = parseDfa(newRaw, "new");
  const budget = parseBudget(budgetRaw);
  const m = options.m === undefined ? Infinity : options.m;

  const { equal, witness, divergentPairs } = compareDfas(oldDfa, newDfa, m);

  let tasks = [];
  let cost = 0;
  if (!equal) {
    const allTasks = buildTasks(oldDfa, newDfa, divergentPairs);
    const cover = minCostCover(allTasks, divergentPairs.length);
    if (cover.cost > budget) {
      throw new InfeasibleError(cover.cost, budget);
    }
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    tasks = cover.ids.map((id) => ({ id, cost: byId.get(id).cost }));
    cost = cover.cost;
  }

  const result = { equal, witness, tasks, cost };
  return { ...result, planHash: buildPlan(result).planHash };
}

export { parseDfa, parseBudget, compareDfas, buildTasks, minCostCover };
export { buildPlan, savePlan, loadPlan, PlanStore, PlanError, planHash, canonicalize } from "./plan.js";
export { ValidationError } from "./dfa.js";
