import { filterPushdownIntoJoin, outerToInnerJoin, projectEliminationIdentity, projectEliminationNested, } from "./rules.js";
/**
 * Terminating rule subset used by the fixed-point optimizer. The symmetric
 * rules (join commutativity, left/right swap) are intentionally excluded
 * here — they are heuristics, not improvements, and would oscillate; they
 * remain available as standalone, certified, exhaustively verified rewrites.
 */
export const terminatingRules = [
    filterPushdownIntoJoin,
    outerToInnerJoin,
    projectEliminationIdentity,
    projectEliminationNested,
];
/** Bottom-up fixed-point rewrite; every applied rule appends its certificate. */
export function optimize(plan, rules = terminatingRules) {
    const certificates = [];
    const rewriteNode = (p) => {
        // Children first.
        let cur = p;
        switch (cur.op) {
            case "filter":
                cur = { ...cur, input: rewriteNode(cur.input) };
                break;
            case "project":
                cur = { ...cur, input: rewriteNode(cur.input) };
                break;
            case "join":
                cur = { ...cur, left: rewriteNode(cur.left), right: rewriteNode(cur.right) };
                break;
            case "scan": break;
        }
        // Local fixed point over the rule set.
        let changed = true;
        let guard = 0;
        while (changed && guard++ < 100) {
            changed = false;
            for (const rule of rules) {
                const r = rule(cur);
                if (r) {
                    certificates.push(r.certificate);
                    cur = r.plan;
                    changed = true;
                    break; // restart rule scan after each successful rewrite
                }
            }
        }
        return cur;
    };
    return { plan: rewriteNode(plan), certificates };
}
