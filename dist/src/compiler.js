import { sha256 } from "./hash.js";
import { sccTopoOrder } from "./graph.js";
import { summarize } from "./summaries.js";
/**
 * Plan components from module summaries.
 *
 * Cache-key design (the heart of the interface/implementation split):
 *  - own part: every member's (name, ifaceHash, implHash);
 *  - dep part: for every cross-component import edge, the *interface* hash
 *    of the imported module.
 *
 * Consequences:
 *  - impl-only edit in a dependency -> dependent key unchanged -> cache hit;
 *  - interface edit in a dependency -> dependent key changes -> recompiled;
 *  - any edit inside an SCC -> the whole SCC key changes -> batch recompile.
 */
export function planComponents(summaries) {
    const byName = new Map(summaries.map((s) => [s.name, s]));
    const edges = new Map(summaries.map((s) => [
        s.name,
        s.imports.filter((imp) => imp !== s.name && byName.has(imp)),
    ]));
    const components = sccTopoOrder(summaries.map((s) => s.name), edges);
    const componentOf = new Map();
    components.forEach((members, i) => {
        for (const m of members)
            componentOf.set(m, i);
    });
    return components.map((members) => {
        const ownPart = members.map((m) => {
            const s = byName.get(m);
            return `${m}:${s.ifaceHash}:${s.implHash}`;
        });
        const depPart = [];
        for (const m of members) {
            for (const imp of edges.get(m)) {
                if (componentOf.get(imp) !== componentOf.get(m)) {
                    depPart.push(`${m}->${imp}:${byName.get(imp).ifaceHash}`);
                }
            }
        }
        depPart.sort();
        return {
            id: members.join("+"),
            members,
            key: sha256("component", ...ownPart, ...depPart),
        };
    });
}
/** Deterministic "codegen": the artifact is a pure function of the key. */
export function compileArtifact(plan) {
    return sha256("artifact", plan.key);
}
export class Compiler {
    store;
    constructor(store) {
        this.store = store;
    }
    build(sources) {
        const summaries = sources.map(summarize);
        const plans = planComponents(summaries);
        const compiled = [];
        const reused = [];
        const artifacts = new Map();
        for (const plan of plans) {
            let artifact = this.store.get(plan.key);
            if (artifact === undefined) {
                artifact = compileArtifact(plan);
                this.store.put(plan.key, artifact);
                compiled.push(plan.id);
            }
            else {
                reused.push(plan.id);
            }
            artifacts.set(plan.id, artifact);
        }
        return { plans, compiled, reused, artifacts, summaries };
    }
}
/** Reference model: a full from-scratch compile with a cold cache. */
export function fullCompile(sources, store) {
    return new Compiler(store).build(sources);
}
