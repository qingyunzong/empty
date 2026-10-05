/**
 * Shortest-plan certificates.
 *
 * A certificate contains the plan plus the BFS layer sizes up to the goal
 * depth. Verification is fully independent of the search that produced it:
 *   1. replay the plan from the initial state and check the goal holds;
 *   2. re-run BFS and confirm the layer sizes match and no goal state
 *      appears at any depth < plan length (optimality).
 */
import { applyAction, initialState, isGoal, stateKey, successors, } from "./model.js";
export function buildCertificate(p, plan, layers, reachable) {
    return {
        type: "shortest-plan",
        problem: p.name,
        plan,
        length: plan.length,
        layers,
        reachable,
    };
}
export function verifyCertificate(p, cert) {
    const errors = [];
    if (cert.type !== "shortest-plan")
        errors.push(`unknown certificate type`);
    if (cert.length !== cert.plan.length)
        errors.push("length != plan.length");
    // 1. Replay the plan.
    const byName = new Map(p.actions.map((a) => [a.name, a]));
    let s = initialState(p);
    for (const [i, name] of cert.plan.entries()) {
        const a = byName.get(name);
        if (!a) {
            errors.push(`step ${i}: unknown action "${name}"`);
            break;
        }
        const ns = applyAction(p, s, a);
        if (!ns) {
            errors.push(`step ${i}: action "${name}" not applicable`);
            break;
        }
        s = ns;
    }
    if (errors.length === 0 && !isGoal(p, s)) {
        errors.push("plan does not reach the goal");
    }
    // 2. Optimality: recompute BFS layers; no goal may appear below depth L.
    const start = initialState(p);
    const seen = new Set([stateKey(start)]);
    let frontier = [start];
    for (let depth = 0; depth < cert.length; depth++) {
        if (cert.layers[depth] !== frontier.length) {
            errors.push(`layer ${depth}: certificate says ${cert.layers[depth]}, recomputed ${frontier.length}`);
        }
        if (frontier.some((st) => isGoal(p, st))) {
            errors.push(`goal reachable at depth ${depth} < ${cert.length}: plan not shortest`);
            break;
        }
        const next = [];
        for (const st of frontier) {
            for (const { state: ns } of successors(p, st)) {
                const nk = stateKey(ns);
                if (seen.has(nk))
                    continue;
                seen.add(nk);
                next.push(ns);
            }
        }
        frontier = next;
    }
    return { ok: errors.length === 0, errors };
}
