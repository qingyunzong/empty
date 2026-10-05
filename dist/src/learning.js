/**
 * Depth-first search with sound nogood learning.
 *
 * A state is recorded as a nogood ("dead") ONLY when every applicable
 * successor is itself already proven dead. Successors that lie on the
 * current DFS path (cycles) make the state UNKNOWN, never dead — so a
 * learned nogood can never exclude an unexplored feasible path.
 *
 * Soundness invariant (by induction on recording order):
 *   key in nogoods  =>  no goal state is reachable from that state.
 */
import { applyAction, initialState, isGoal, stateKey, } from "./model.js";
export function dfsLearn(p, priorNogoods = []) {
    const nogoods = new Set(priorNogoods);
    const plan = [];
    let expansions = 0;
    function visit(s, onPath) {
        expansions++;
        if (isGoal(p, s))
            return "found";
        const key = stateKey(s);
        if (nogoods.has(key))
            return "dead";
        let sawUnknown = false;
        onPath.add(key);
        for (const a of p.actions) {
            const ns = applyAction(p, s, a);
            if (!ns)
                continue;
            const nk = stateKey(ns);
            if (onPath.has(nk)) {
                // Cycle back to an ancestor: this branch is skipped, NOT explored,
                // so it must not contribute to a "dead" verdict.
                sawUnknown = true;
                continue;
            }
            const st = visit(ns, onPath);
            if (st === "found") {
                plan.push(a.name);
                onPath.delete(key);
                return "found";
            }
            if (st === "unknown")
                sawUnknown = true;
        }
        onPath.delete(key);
        if (sawUnknown)
            return "unknown";
        // Every applicable successor was fully explored and proven dead.
        nogoods.add(key);
        return "dead";
    }
    const status = visit(initialState(p), new Set());
    plan.reverse();
    return {
        plan: status === "found" ? plan : null,
        nogoods: [...nogoods],
        expansions,
    };
}
