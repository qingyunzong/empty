/**
 * Full-graph classification model: computes the plan for the whole graph in
 * one batch pass, independent of the executor's incremental state machine.
 */
import { buildGraph, classifyGraph, } from "./graph.js";
export function planFullGraph(defs) {
    const classification = classifyGraph(buildGraph(defs));
    return {
        startSet: classification.startSet,
        isolated: [...classification.isolated].sort(),
        cyclicSccs: [...classification.cyclicSccs].sort((a, b) => a[0] < b[0] ? -1 : 1),
    };
}
