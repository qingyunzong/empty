/**
 * Cross-check: the controllable executor (incremental counters) and the
 * full-graph classification model (batch analysis) must agree on the start
 * set for any graph.
 */
import { ControllableExecutor } from "./executor.js";
import { planFullGraph } from "./model.js";
export function crossCheckStartSet(defs) {
    const executorStartSet = new ControllableExecutor(defs).startSet();
    const modelStartSet = planFullGraph(defs).startSet;
    const consistent = executorStartSet.length === modelStartSet.length &&
        executorStartSet.every((id, i) => id === modelStartSet[i]);
    if (!consistent) {
        throw new Error(`start set mismatch: executor=[${executorStartSet}] model=[${modelStartSet}]`);
    }
    return { executorStartSet, modelStartSet, consistent };
}
