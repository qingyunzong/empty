/**
 * Static reference graph: edges cell -> every address syntactically
 * referenced by its formula. Kept acyclic; the dynamic (runtime) dependency
 * graph is always a subgraph of this one, hence also acyclic.
 */
export class CycleError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CycleError';
    }
}
export class StaticGraph {
    deps = new Map();
    rdeps = new Map();
    refsOf(key) {
        return this.deps.get(key) ?? new Set();
    }
    /** True if making `key` depend on `refs` would create a cycle. */
    wouldCycle(key, refs) {
        for (const r of refs) {
            if (r === key)
                return true;
            if (this.reaches(r, key))
                return true;
        }
        return false;
    }
    /** Can `from` reach `target` by following static dependency edges? */
    reaches(from, target) {
        const seen = new Set([from]);
        const stack = [from];
        while (stack.length > 0) {
            const k = stack.pop();
            for (const d of this.deps.get(k) ?? []) {
                if (d === target)
                    return true;
                if (!seen.has(d)) {
                    seen.add(d);
                    stack.push(d);
                }
            }
        }
        return false;
    }
    /** Replace the outgoing edges of `key`. Call only after wouldCycle passed. */
    set(key, refs) {
        this.remove(key);
        this.deps.set(key, new Set(refs));
        for (const r of refs) {
            let set = this.rdeps.get(r);
            if (!set) {
                set = new Set();
                this.rdeps.set(r, set);
            }
            set.add(key);
        }
    }
    remove(key) {
        for (const d of this.deps.get(key) ?? []) {
            this.rdeps.get(d)?.delete(key);
        }
        this.deps.delete(key);
    }
    /** All cells that statically (transitively) depend on `seed`, excluding seed. */
    dependentsClosure(seed) {
        const out = new Set();
        const queue = [seed];
        while (queue.length > 0) {
            const k = queue.shift();
            for (const dep of this.rdeps.get(k) ?? []) {
                if (!out.has(dep)) {
                    out.add(dep);
                    queue.push(dep);
                }
            }
        }
        return out;
    }
}
