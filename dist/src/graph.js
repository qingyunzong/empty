/**
 * Tarjan's strongly-connected-components, returned in dependency-first
 * topological order (a component appears after every component it depends
 * on). Cyclic modules collapse into one component and are therefore
 * compiled and published as a single batch.
 */
export function sccTopoOrder(nodes, edges) {
    const index = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const components = [];
    let counter = 0;
    const visit = (v) => {
        index.set(v, counter);
        lowlink.set(v, counter);
        counter += 1;
        stack.push(v);
        onStack.add(v);
        for (const w of edges.get(v) ?? []) {
            if (!index.has(w)) {
                visit(w);
                lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
            }
            else if (onStack.has(w)) {
                lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
            }
        }
        if (lowlink.get(v) === index.get(v)) {
            const component = [];
            for (;;) {
                const w = stack.pop();
                onStack.delete(w);
                component.push(w);
                if (w === v)
                    break;
            }
            components.push(component);
        }
    };
    for (const node of [...nodes].sort()) {
        if (!index.has(node))
            visit(node);
    }
    const componentOf = new Map();
    components.forEach((component, i) => {
        for (const member of component)
            componentOf.set(member, i);
    });
    const emitted = new Set();
    const ordered = [];
    const emit = (ci) => {
        if (emitted.has(ci))
            return;
        emitted.add(ci);
        for (const member of components[ci]) {
            for (const dep of edges.get(member) ?? []) {
                const di = componentOf.get(dep);
                if (di !== ci)
                    emit(di);
            }
        }
        ordered.push([...components[ci]].sort());
    };
    components.forEach((_, i) => emit(i));
    return ordered;
}
