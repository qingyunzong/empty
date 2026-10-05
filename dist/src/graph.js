/**
 * Dependency-graph primitives shared by the executor and the full-graph model.
 *
 * Edge convention: if case A declares `dependsOn: [B]`, then B must pass
 * before A may run. `dependents` adjacency points from prerequisite to the
 * cases waiting on it (B -> A), which is also the direction in which cycle
 * isolation and failure cancellation propagate.
 */
export function buildGraph(defs) {
    const ids = [];
    const known = new Set();
    for (const def of defs) {
        if (known.has(def.id)) {
            throw new Error(`duplicate test case id: ${def.id}`);
        }
        known.add(def.id);
        ids.push(def.id);
    }
    const deps = new Map();
    const dependents = new Map();
    for (const id of ids) {
        deps.set(id, []);
        dependents.set(id, []);
    }
    for (const def of defs) {
        for (const dep of def.dependsOn ?? []) {
            if (!known.has(dep)) {
                throw new Error(`unknown dependency "${dep}" referenced by "${def.id}"`);
            }
            deps.get(def.id).push(dep);
            dependents.get(dep).push(def.id);
        }
    }
    return { ids, deps, dependents };
}
/** Tarjan's algorithm, iterative to stay safe on deep graphs. */
export function stronglyConnectedComponents(graph) {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];
    let counter = 0;
    for (const root of graph.ids) {
        if (index.has(root))
            continue;
        index.set(root, counter);
        low.set(root, counter);
        counter += 1;
        stack.push(root);
        onStack.add(root);
        const work = [{ node: root, child: 0 }];
        while (work.length > 0) {
            const frame = work[work.length - 1];
            const successors = graph.dependents.get(frame.node);
            if (frame.child < successors.length) {
                const next = successors[frame.child];
                frame.child += 1;
                if (!index.has(next)) {
                    index.set(next, counter);
                    low.set(next, counter);
                    counter += 1;
                    stack.push(next);
                    onStack.add(next);
                    work.push({ node: next, child: 0 });
                }
                else if (onStack.has(next)) {
                    low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
                }
            }
            else {
                work.pop();
                const parent = work[work.length - 1];
                if (parent !== undefined) {
                    low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
                }
                if (low.get(frame.node) === index.get(frame.node)) {
                    const scc = [];
                    let member;
                    do {
                        member = stack.pop();
                        onStack.delete(member);
                        scc.push(member);
                    } while (member !== frame.node);
                    sccs.push(scc);
                }
            }
        }
    }
    return sccs;
}
/**
 * Full-graph classification: only cyclic SCCs and their transitive
 * dependents are isolated; every other case stays executable.
 */
export function classifyGraph(graph) {
    const cyclicSccs = [];
    const isolated = new Set();
    for (const scc of stronglyConnectedComponents(graph)) {
        const isCycle = scc.length > 1 || graph.dependents.get(scc[0]).includes(scc[0]);
        if (!isCycle)
            continue;
        cyclicSccs.push([...scc].sort());
        for (const id of scc)
            isolated.add(id);
    }
    // Propagate isolation downstream: anything depending on a cycle can never
    // have its prerequisites satisfied, so it is isolated as well.
    const queue = [...isolated];
    while (queue.length > 0) {
        const current = queue.pop();
        for (const next of graph.dependents.get(current)) {
            if (!isolated.has(next)) {
                isolated.add(next);
                queue.push(next);
            }
        }
    }
    const executable = new Set(graph.ids.filter((id) => !isolated.has(id)));
    const startSet = graph.ids
        .filter((id) => executable.has(id) && graph.deps.get(id).length === 0)
        .sort();
    return { cyclicSccs, isolated, executable, startSet };
}
