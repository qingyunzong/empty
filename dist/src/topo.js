import { compareCandidate } from "./model.js";
import { MinHeap } from "./heap.js";
/** Build the orderable subgraph plus missing-dependency evidence. */
export function buildGraph(events) {
    const byId = new Map();
    for (const e of events) {
        if (byId.has(e.id))
            throw new Error(`duplicate event id: ${e.id}`);
        byId.set(e.id, e);
    }
    const missingIndex = new Map();
    const missing = [];
    for (const e of events) {
        for (const d of e.deps) {
            if (!byId.has(d)) {
                missing.push({ eventId: e.id, missingDep: d });
                const list = missingIndex.get(d) ?? [];
                list.push(e.id);
                missingIndex.set(d, list);
            }
        }
    }
    for (const list of missingIndex.values())
        list.sort();
    // Blocked: events that (transitively) depend on a missing id.
    const allDependents = new Map();
    for (const e of events) {
        for (const d of e.deps) {
            const list = allDependents.get(d) ?? [];
            list.push(e.id);
            allDependents.set(d, list);
        }
    }
    const blocked = new Set();
    const queue = [];
    for (const m of missing) {
        if (!blocked.has(m.eventId)) {
            blocked.add(m.eventId);
            queue.push(m.eventId);
        }
    }
    while (queue.length > 0) {
        const cur = queue.pop();
        for (const nxt of allDependents.get(cur) ?? []) {
            if (!blocked.has(nxt)) {
                blocked.add(nxt);
                queue.push(nxt);
            }
        }
    }
    const depsOf = new Map();
    const dependents = new Map();
    for (const e of events) {
        if (blocked.has(e.id))
            continue;
        const known = e.deps.filter((d) => byId.has(d) && !blocked.has(d));
        depsOf.set(e.id, known);
        for (const d of known) {
            const list = dependents.get(d) ?? [];
            list.push(e.id);
            dependents.set(d, list);
        }
    }
    return { byId, missingIndex, missing, blocked, depsOf, dependents };
}
/** Extract one concrete cycle per remaining cyclic component, as evidence. */
export function findCycles(nodes, depsOf) {
    const nodeSet = new Set(nodes);
    const cycles = [];
    const done = new Set();
    for (const start of nodes) {
        if (done.has(start))
            continue;
        // DFS from start looking for a path back to any visited node.
        const stack = [];
        const onPath = new Map();
        let found = null;
        const dfs = (u) => {
            onPath.set(u, stack.length);
            stack.push(u);
            for (const v of depsOf.get(u) ?? []) {
                if (!nodeSet.has(v))
                    continue;
                const idx = onPath.get(v);
                if (idx !== undefined) {
                    found = [...stack.slice(idx), v];
                    return true;
                }
                if (!done.has(v) && dfs(v))
                    return true;
            }
            stack.pop();
            onPath.delete(u);
            return false;
        };
        if (dfs(start) && found !== null) {
            const cyc = found;
            cycles.push(cyc);
            for (const id of cyc)
                done.add(id);
        }
        else {
            done.add(start);
        }
    }
    return cycles;
}
/**
 * Greedy topological sort: each round emits the ready candidate with the
 * smallest (ts, source, seq, id). Timestamps are only a tie-breaking
 * priority; they are NOT required to be causally monotonic.
 */
export function sortEvents(events, opts = {}) {
    const g = buildGraph(events);
    const prefix = opts.prefix ?? [];
    const emitted = new Set();
    for (const id of prefix) {
        const e = g.byId.get(id);
        if (!e)
            throw new Error(`prefix references unknown event: ${id}`);
        if (g.blocked.has(id))
            throw new Error(`prefix references blocked event: ${id}`);
        for (const d of e.deps) {
            if (g.byId.has(d) && !emitted.has(d))
                throw new Error(`prefix infeasible: ${id} depends on ${d}, which is not earlier in the prefix`);
        }
        emitted.add(id);
    }
    const indegree = new Map();
    for (const [id, deps] of g.depsOf) {
        if (emitted.has(id))
            continue;
        indegree.set(id, deps.filter((d) => !emitted.has(d)).length);
    }
    const heap = new MinHeap(compareCandidate);
    for (const [id, deg] of indegree) {
        if (deg === 0)
            heap.push(g.byId.get(id));
    }
    const order = [];
    let cur;
    while ((cur = heap.pop()) !== undefined) {
        order.push(cur.id);
        for (const nxt of g.dependents.get(cur.id) ?? []) {
            if (emitted.has(nxt))
                continue;
            const d = indegree.get(nxt);
            if (d === undefined)
                continue;
            if (d - 1 === 0)
                heap.push(g.byId.get(nxt));
            indegree.set(nxt, d - 1);
        }
    }
    const ordered = new Set(order);
    const remaining = [...indegree.keys()].filter((id) => !ordered.has(id));
    const cycles = findCycles(remaining, g.depsOf);
    return {
        order,
        missing: g.missing,
        missingIndex: g.missingIndex,
        blocked: [...g.blocked].sort(),
        cycles,
    };
}
