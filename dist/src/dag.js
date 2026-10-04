"use strict";
/**
 * Dependency DAG used to derive observation weights from raw sources.
 *
 * Node kinds:
 *  - source:       an externally supplied number.
 *  - derived:      pure function of a static list of dependencies.
 *  - conditional:  evaluates its condition dependencies, selects a branch,
 *                  and only then evaluates that branch's dependencies.
 *                  Dependencies of unselected branches are never evaluated.
 *
 * DagEngine evaluates lazily and incrementally: a source change dirties its
 * transitive dependents (along the dependency edges actually used in the
 * previous generation) and only dirty nodes are recomputed on demand.
 *
 * evaluateDagModel is the independent reference model: a plain memoized
 * full evaluation from scratch, used by tests to cross-check the engine.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DagEngine = exports.DagError = void 0;
exports.evaluateDagModel = evaluateDagModel;
class DagError extends Error {
}
exports.DagError = DagError;
class DagEngine {
    specs = new Map();
    sourceValues = new Map();
    values = new Map();
    usedDeps = new Map();
    dependents = new Map();
    dirty = new Set();
    /** Instrumentation: number of node (re)computations performed. */
    computeCalls = 0;
    addSource(name, initial) {
        this.assertNew(name);
        if (!Number.isFinite(initial))
            throw new DagError(`source ${name} must be finite`);
        this.specs.set(name, { kind: "source" });
        this.sourceValues.set(name, initial);
    }
    addNode(name, spec) {
        this.assertNew(name);
        this.specs.set(name, spec);
    }
    hasNode(name) {
        return this.specs.has(name);
    }
    getSources() {
        return new Map(this.sourceValues);
    }
    getSpecs() {
        return new Map(this.specs);
    }
    /** Apply a batch of source changes as one logical update. */
    applySourceChanges(changes) {
        for (const [name, value] of changes) {
            if (!this.sourceValues.has(name))
                throw new DagError(`unknown source: ${name}`);
            if (!Number.isFinite(value))
                throw new DagError(`source ${name} must be finite`);
            if (Object.is(this.sourceValues.get(name), value))
                continue;
            this.sourceValues.set(name, value);
            // Sources are read directly from sourceValues, so they never enter the
            // dirty set themselves; only their dependents need recomputation.
            for (const dependent of this.dependents.get(name) ?? [])
                this.markDirty(dependent);
        }
    }
    /** Evaluate one node, recomputing only what is dirty. */
    evaluate(name) {
        return this.evalNode(name, new Set());
    }
    /** Evaluate the given output nodes into a fresh map. */
    evaluateOutputs(outputs) {
        const out = new Map();
        for (const name of outputs)
            out.set(name, this.evaluate(name));
        return out;
    }
    assertNew(name) {
        if (this.specs.has(name))
            throw new DagError(`duplicate node: ${name}`);
    }
    markDirty(name) {
        if (this.dirty.has(name))
            return;
        this.dirty.add(name);
        for (const dependent of this.dependents.get(name) ?? [])
            this.markDirty(dependent);
    }
    evalNode(name, visiting) {
        const spec = this.specs.get(name);
        if (spec === undefined)
            throw new DagError(`unknown node: ${name}`);
        if (spec.kind === "source")
            return this.sourceValues.get(name);
        if (!this.dirty.has(name) && this.values.has(name))
            return this.values.get(name);
        if (visiting.has(name))
            throw new DagError(`dependency cycle at node: ${name}`);
        visiting.add(name);
        let deps;
        let value;
        if (spec.kind === "derived") {
            deps = spec.deps;
            value = spec.compute(deps.map((d) => this.evalNode(d, visiting)));
        }
        else {
            const conditionVals = spec.conditionDeps.map((d) => this.evalNode(d, visiting));
            const branchKey = spec.select(conditionVals);
            const branch = spec.branches[branchKey];
            if (branch === undefined) {
                throw new DagError(`conditional node ${name}: no branch named "${branchKey}"`);
            }
            const branchVals = branch.deps.map((d) => this.evalNode(d, visiting));
            deps = [...spec.conditionDeps, ...branch.deps];
            value = branch.compute(branchVals);
        }
        visiting.delete(name);
        this.computeCalls++;
        this.setUsedDeps(name, deps);
        this.values.set(name, value);
        this.dirty.delete(name);
        return value;
    }
    setUsedDeps(name, deps) {
        for (const old of this.usedDeps.get(name) ?? [])
            this.dependents.get(old)?.delete(name);
        const unique = [...new Set(deps)];
        this.usedDeps.set(name, unique);
        for (const dep of unique) {
            let set = this.dependents.get(dep);
            if (set === undefined) {
                set = new Set();
                this.dependents.set(dep, set);
            }
            set.add(name);
        }
    }
}
exports.DagEngine = DagEngine;
/**
 * Reference model: full memoized evaluation of `outputs` from scratch.
 * Shares no state with any DagEngine, so tests can use it to verify the
 * incremental engine produces identical results.
 */
function evaluateDagModel(specs, sources, outputs) {
    const memo = new Map();
    const visiting = new Set();
    const evalNode = (name) => {
        const spec = specs.get(name);
        if (spec === undefined)
            throw new DagError(`unknown node: ${name}`);
        if (spec.kind === "source") {
            const v = sources.get(name);
            if (v === undefined)
                throw new DagError(`missing source value: ${name}`);
            return v;
        }
        const cached = memo.get(name);
        if (cached !== undefined)
            return cached;
        if (visiting.has(name))
            throw new DagError(`dependency cycle at node: ${name}`);
        visiting.add(name);
        let value;
        if (spec.kind === "derived") {
            value = spec.compute(spec.deps.map(evalNode));
        }
        else {
            const branchKey = spec.select(spec.conditionDeps.map(evalNode));
            const branch = spec.branches[branchKey];
            if (branch === undefined) {
                throw new DagError(`conditional node ${name}: no branch named "${branchKey}"`);
            }
            value = branch.compute(branch.deps.map(evalNode));
        }
        visiting.delete(name);
        memo.set(name, value);
        return value;
    };
    const out = new Map();
    for (const name of outputs)
        out.set(name, evalNode(name));
    return out;
}
