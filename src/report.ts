import { JsonValue, ProblemSpec } from "./model.js";
import { analyze, findMinimumSize, selectRepresentatives } from "./solver.js";
import { DEFAULT_COMBINATION_LIMIT, VerificationResult, verifyByEnumeration } from "./verify.js";

export interface EquivalentPairReport {
  strategies: [string, string];
  evidence: {
    reason: string;
    /** The identical output both strategies produce for every candidate sample. */
    sharedOutputs: JsonValue[];
  };
}

export interface PlanReport {
  summary: {
    strategyCount: number;
    sampleCount: number;
    pairCount: number;
    distinguishablePairCount: number;
    equivalentPairCount: number;
    uselessSampleIds: string[];
    interchangeableSampleGroups: string[][];
  };
  selection: {
    count: number;
    /** Sample ids to run, sorted lexicographically. */
    sampleIds: string[];
  };
  equivalentPairs: EquivalentPairReport[];
  verification: VerificationResult;
}

export function plan(
  problem: ProblemSpec,
  combinationLimit: number = DEFAULT_COMBINATION_LIMIT
): PlanReport {
  const analysis = analyze(problem);
  const minimumSize = findMinimumSize(analysis.columns, analysis.fullMask);
  const sampleIds = selectRepresentatives(
    analysis.columns,
    minimumSize,
    analysis.fullMask
  );
  const verification = verifyByEnumeration(
    analysis.columns.map((c) => c.pairMask),
    analysis.fullMask,
    minimumSize,
    combinationLimit
  );

  const strategyOutputs = new Map(
    problem.strategies.map((s) => [s.id, s.outputs])
  );

  const equivalentPairs: EquivalentPairReport[] = analysis.equivalentPairs.map(
    (pair) => {
      const [a, b] = pair.strategies;
      return {
        strategies: pair.strategies,
        evidence: {
          reason:
            `strategies ${JSON.stringify(a)} and ${JSON.stringify(b)} produce ` +
            `identical outputs on all ${analysis.sampleIds.length} candidate samples; ` +
            `no sample can distinguish them`,
          sharedOutputs: strategyOutputs.get(a)!,
        },
      };
    }
  );

  return {
    summary: {
      strategyCount: analysis.strategyIds.length,
      sampleCount: analysis.sampleIds.length,
      pairCount: analysis.pairs.length,
      distinguishablePairCount: analysis.distinguishablePairCount,
      equivalentPairCount: analysis.equivalentPairs.length,
      uselessSampleIds: analysis.uselessSampleIds,
      interchangeableSampleGroups: analysis.columns
        .filter((c) => c.memberIds.length > 1)
        .map((c) => c.memberIds),
    },
    selection: { count: sampleIds.length, sampleIds },
    equivalentPairs,
    verification,
  };
}
