import { createHash } from "node:crypto";
import type { Problem, Solution } from "./types.js";
import type { BruteForceResult } from "./solver.js";

export interface Certificate {
  version: 1;
  status: "optimal" | "infeasible";
  objective: { revenue: number; cost: number; impressions: number };
  allocation: Array<{
    group: string;
    channel: string;
    amount: number;
    cost: number;
    impressions: number;
    revenue: number;
  }>;
  budgetCertificate: {
    channels: Array<{ id: string; budget: number; spent: number; remaining: number; withinBudget: boolean }>;
    impressions: { required: number; delivered: number; satisfied: boolean };
    totalCost: number;
    checks: {
      allIntegers: boolean;
      amountsWithinRange: boolean;
      allBudgetsRespected: boolean;
      impressionsSatisfied: boolean;
    };
  };
  optimality: {
    method: string;
    dpStatesExplored: number;
    bruteForce: null | { nodes: number; revenue: number | null; cost: number | null; matches: boolean };
  };
  fingerprint: string;
}

export function buildCertificate(
  problem: Problem,
  solution: Solution,
  brute: BruteForceResult | null,
): Certificate {
  const amounts = solution.amounts ?? problem.groups.map(() => 0);

  const allocation = problem.groups.map((g, i) => {
    const amount = amounts[i] as number;
    return {
      group: g.id,
      channel: g.channel,
      amount,
      cost: amount * g.unitCost,
      impressions: amount * g.unitImpressions,
      revenue: solution.feasible ? (g.revenue[amount] as number) : 0,
    };
  });

  const spentByChannel = new Map<string, number>();
  for (const row of allocation) {
    spentByChannel.set(row.channel, (spentByChannel.get(row.channel) ?? 0) + row.cost);
  }
  const channels = problem.channels.map((c) => {
    const spent = spentByChannel.get(c.id) ?? 0;
    return { id: c.id, budget: c.budget, spent, remaining: c.budget - spent, withinBudget: spent <= c.budget };
  });

  const delivered = allocation.reduce((sum, row) => sum + row.impressions, 0);
  const totalCost = allocation.reduce((sum, row) => sum + row.cost, 0);
  const totalRevenue = allocation.reduce((sum, row) => sum + row.revenue, 0);

  const checks = {
    allIntegers: allocation.every((row) => Number.isInteger(row.amount)),
    amountsWithinRange: allocation.every((row) => row.amount >= 0 && row.amount <= 10),
    allBudgetsRespected: channels.every((c) => c.withinBudget),
    impressionsSatisfied: !solution.feasible ? delivered >= problem.minImpressions : delivered >= problem.minImpressions,
  };

  const bruteForce = brute === null
    ? null
    : {
        nodes: brute.nodes,
        revenue: brute.feasible ? brute.revenue : null,
        cost: brute.feasible ? brute.cost : null,
        matches:
          brute.feasible === solution.feasible &&
          (!brute.feasible || (brute.revenue === solution.revenue && brute.cost === solution.cost)),
      };

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        status: solution.feasible ? "optimal" : "infeasible",
        amounts,
        revenue: totalRevenue,
        cost: totalCost,
        impressions: delivered,
        channels: channels.map((c) => [c.id, c.budget, c.spent]),
        minImpressions: problem.minImpressions,
      }),
    )
    .digest("hex");

  return {
    version: 1,
    status: solution.feasible ? "optimal" : "infeasible",
    objective: { revenue: totalRevenue, cost: totalCost, impressions: delivered },
    allocation,
    budgetCertificate: {
      channels,
      impressions: {
        required: problem.minImpressions,
        delivered,
        satisfied: delivered >= problem.minImpressions,
      },
      totalCost,
      checks,
    },
    optimality: {
      method: "exact-dp: per-channel pareto frontier + cross-channel merge (enumerates all integer allocations implicitly)",
      dpStatesExplored: solution.stats.statesExplored,
      bruteForce,
    },
    fingerprint,
  };
}
