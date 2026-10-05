import { Problem } from "./model";
import { buildDistinguishData, firstFeasibleOfSize, minimumCoverSize } from "./solver";
import { verifyByEnumeration, VerifyResult } from "./verify";

export const DEFAULT_VERIFY_BUDGET = 20_000_000;

export interface EquivalenceClass {
  strategies: string[];
  evidence: {
    reason: string;
    identicalOutputs: Record<string, unknown>;
  };
}

export interface PlanResult {
  input: { strategies: number; samples: number };
  pairs: { total: number; distinguishable: number; equivalent: number };
  minimumSamples: number;
  selectedSamples: string[];
  equivalenceClasses: EquivalenceClass[];
  verification: {
    method: string;
    confirmed: boolean;
    optimalSolutionCount: number | null;
    nodesVisited: number | null;
    budgetExhausted?: boolean;
    note?: string;
  };
}

export interface PlanOptions {
  verify?: boolean;
  verifyBudget?: number;
}

function unionFindClasses(count: number, pairs: Array<[number, number]>): number[][] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return [...groups.values()].filter((members) => members.length > 1);
}

export function planTests(problem: Problem, options: PlanOptions = {}): PlanResult {
  const verify = options.verify !== false;
  const budget = options.verifyBudget ?? DEFAULT_VERIFY_BUDGET;
  const data = buildDistinguishData(problem);
  const sampleCount = problem.sampleIds.length;
  const strategyCount = problem.strategies.length;
  const totalPairs = (strategyCount * (strategyCount - 1)) / 2;

  const equivalenceClasses: EquivalenceClass[] = unionFindClasses(
    strategyCount,
    data.equivalentPairs
  ).map((members) => {
    const representative = problem.strategies[members[0]!]!;
    const identicalOutputs: Record<string, unknown> = {};
    problem.sampleIds.forEach((sampleId, index) => {
      identicalOutputs[sampleId] = representative.outputs[index];
    });
    return {
      strategies: members.map((index) => problem.strategies[index]!.id),
      evidence: {
        reason: `identical outputs on all ${sampleCount} candidate sample(s); no candidate sample can distinguish these strategies`,
        identicalOutputs,
      },
    };
  });

  const minimum = minimumCoverSize(data);

  const order = Array.from({ length: sampleCount }, (_, i) => i).sort((a, b) =>
    problem.sampleIds[a]! < problem.sampleIds[b]! ? -1 : 1
  );
  const selected = firstFeasibleOfSize(data.sampleCover, data.fullCover, minimum, order);
  if (selected === null) {
    throw new Error("internal error: solver reported a size with no feasible subset");
  }
  const selectedSamples = selected.map((index) => problem.sampleIds[index]!).sort();

  let verification: PlanResult["verification"];
  if (verify) {
    const result: VerifyResult = verifyByEnumeration(
      data.sampleCover,
      data.fullCover,
      minimum,
      budget
    );
    if (result.counterexample !== null) {
      throw new Error(
        `internal error: enumeration found a smaller feasible subset of size ${result.counterexample.length}`
      );
    }
    verification = {
      method: "exhaustive subset enumeration (sizes 0..k-1 infeasible, size k counted)",
      confirmed: result.confirmed,
      optimalSolutionCount: result.budgetExhausted ? null : result.optimalCount,
      nodesVisited: result.nodesVisited,
    };
    if (result.budgetExhausted) {
      verification.budgetExhausted = true;
      verification.note = `enumeration stopped at the node budget of ${budget}; minimality not independently confirmed`;
    }
  } else {
    verification = {
      method: "skipped (--no-verify)",
      confirmed: false,
      optimalSolutionCount: null,
      nodesVisited: null,
      note: "independent enumeration check disabled",
    };
  }

  return {
    input: { strategies: strategyCount, samples: sampleCount },
    pairs: {
      total: totalPairs,
      distinguishable: data.requiredPairs.length,
      equivalent: data.equivalentPairs.length,
    },
    minimumSamples: minimum,
    selectedSamples,
    equivalenceClasses,
    verification,
  };
}
