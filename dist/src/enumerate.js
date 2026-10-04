import { buildGraph } from "./topo.js";
/**
 * Enumerate all topological orders of the orderable subgraph
 * (events blocked by missing dependencies are excluded).
 * Stops after `limit` orders and reports `truncated`.
 * Intended for small graphs (cross-checking the greedy order).
 */
export function enumerateTopoOrders(events, limit = 100_000) {
    const g = buildGraph(events);
    const ids = [...g.depsOf.keys()].sort();
    const indegree = new Map();
    for (const id of ids)
        indegree.set(id, (g.depsOf.get(id) ?? []).length);
    const orders = [];
    const current = [];
    let truncated = false;
    const ready = () => ids.filter((id) => !current.includes(id) && indegree.get(id) === 0);
    const backtrack = () => {
        if (truncated)
            return;
        if (current.length === ids.length) {
            orders.push([...current]);
            if (orders.length >= limit)
                truncated = true;
            return;
        }
        for (const id of ready()) {
            current.push(id);
            for (const nxt of g.dependents.get(id) ?? [])
                indegree.set(nxt, indegree.get(nxt) - 1);
            backtrack();
            for (const nxt of g.dependents.get(id) ?? [])
                indegree.set(nxt, indegree.get(nxt) + 1);
            current.pop();
            if (truncated)
                return;
        }
    };
    backtrack();
    return { orders, truncated, totalNodes: ids.length };
}
/** Check that `order` is one of the enumerated topological orders. */
export function containsOrder(orders, order) {
    const key = JSON.stringify(order);
    return orders.some((o) => JSON.stringify(o) === key);
}
