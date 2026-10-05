/**
 * Cross-check: the controllable executor (incremental counters) and the
 * full-graph classification model (batch analysis) must agree on the start
 * set for any graph.
 */

import { ControllableExecutor } from "./executor.js";
import { planFullGraph } from "./model.js";
import type { TestCaseDef } from "./graph.js";

export interface StartSetAgreement {
  readonly executorStartSet: readonly string[];
  readonly modelStartSet: readonly string[];
  readonly consistent: boolean;
}

export function crossCheckStartSet(
  defs: readonly TestCaseDef[],
): StartSetAgreement {
  const executorStartSet = new ControllableExecutor(defs).startSet();
  const modelStartSet = planFullGraph(defs).startSet;
  const consistent =
    executorStartSet.length === modelStartSet.length &&
    executorStartSet.every((id, i) => id === modelStartSet[i]);
  if (!consistent) {
    throw new Error(
      `start set mismatch: executor=[${executorStartSet}] model=[${modelStartSet}]`,
    );
  }
  return { executorStartSet, modelStartSet, consistent };
}
