/**
 * Full-graph classification model: computes the plan for the whole graph in
 * one batch pass, independent of the executor's incremental state machine.
 */

import {
  buildGraph,
  classifyGraph,
  type TestCaseDef,
} from "./graph.js";

export interface FullGraphPlan {
  /** Ids that may be started immediately, sorted by id. */
  readonly startSet: readonly string[];
  /** Ids excluded from execution (cyclic SCCs + their downstream), sorted. */
  readonly isolated: readonly string[];
  /** Cyclic SCCs, members sorted by id, SCCs sorted by first member. */
  readonly cyclicSccs: readonly string[][];
}

export function planFullGraph(defs: readonly TestCaseDef[]): FullGraphPlan {
  const classification = classifyGraph(buildGraph(defs));
  return {
    startSet: classification.startSet,
    isolated: [...classification.isolated].sort(),
    cyclicSccs: [...classification.cyclicSccs].sort((a, b) =>
      a[0]! < b[0]! ? -1 : 1,
    ),
  };
}
