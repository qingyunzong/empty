import { caseRng } from "./rng.js";
export function serializeCheckpoint(cp) {
    return JSON.stringify(cp);
}
export function parseCheckpoint(s) {
    return JSON.parse(s);
}
function defaultSerialize(v) {
    try {
        const s = JSON.stringify(v);
        if (s !== undefined)
            return s;
    }
    catch {
        /* fall through */
    }
    return String(v);
}
function classify(property, value) {
    try {
        const r = property(value);
        return r === false ? { outcome: "failure" } : { outcome: "pass" };
    }
    catch (err) {
        return { outcome: "exception", error: err instanceof Error ? err.message : String(err) };
    }
}
function makeEvaluator(property, serialize, trace, counter) {
    return (v, phase) => {
        const r = classify(property, v);
        trace.push({
            index: counter.n,
            phase,
            value: serialize(v),
            outcome: r.outcome,
            ...(r.error !== undefined ? { error: r.error } : {}),
        });
        counter.n++;
        return r;
    };
}
export function check(params) {
    const seed = params.seed ?? (Date.now() % 0x7fffffff);
    const numRuns = params.numRuns ?? 100;
    const serialize = params.serialize ?? defaultSerialize;
    const trace = [];
    const counter = { n: 0 };
    const evaluate = makeEvaluator(params.property, serialize, trace, counter);
    for (let runIndex = 0; runIndex < numRuns; runIndex++) {
        const caseTree = params.arb.generate(caseRng(seed, runIndex));
        const rootOutcome = evaluate(caseTree.value, "generate");
        if (rootOutcome.outcome === "pass")
            continue;
        const state = {
            node: caseTree,
            nodeOutcome: rootOutcome,
            path: [],
            tested: new Set([serialize(caseTree.value)]),
            steps: 0,
            done: false,
        };
        shrinkLoop(state, evaluate, serialize, params.maxShrinkSteps ?? Infinity);
        const result = buildResult(seed, numRuns, trace, counter.n, state);
        if (!state.done) {
            result.checkpoint = serializeCheckpoint({
                seed, runIndex, path: state.path, tested: [...state.tested],
                nodeOutcome: state.nodeOutcome, evaluations: counter.n, trace,
            });
        }
        return result;
    }
    return { status: "passed", seed, numRuns, evaluations: counter.n, trace, shrinkSteps: 0, isMinimal: true };
}
/**
 * Resume a paused shrink from a checkpoint. The same case tree is
 * regenerated deterministically from (seed, runIndex); candidates recorded
 * in the checkpoint are never evaluated again.
 */
export function resume(params, checkpoint) {
    const cp = typeof checkpoint === "string" ? parseCheckpoint(checkpoint) : checkpoint;
    const serialize = params.serialize ?? defaultSerialize;
    const trace = [...cp.trace];
    const counter = { n: cp.evaluations };
    const evaluate = makeEvaluator(params.property, serialize, trace, counter);
    const caseTree = params.arb.generate(caseRng(cp.seed, cp.runIndex));
    let node = caseTree;
    for (const idx of cp.path) {
        const children = [...node.children()];
        const next = children[idx];
        if (!next)
            throw new Error(`checkpoint path does not match regenerated tree at depth ${idx}`);
        node = next;
    }
    const state = {
        node,
        nodeOutcome: cp.nodeOutcome,
        path: [...cp.path],
        tested: new Set(cp.tested),
        steps: 0,
        done: false,
    };
    shrinkLoop(state, evaluate, serialize, params.maxShrinkSteps ?? Infinity);
    const result = buildResult(cp.seed, params.numRuns ?? 100, trace, counter.n, state);
    if (!state.done) {
        result.checkpoint = serializeCheckpoint({
            seed: cp.seed, runIndex: cp.runIndex, path: state.path, tested: [...state.tested],
            nodeOutcome: state.nodeOutcome, evaluations: counter.n, trace,
        });
    }
    return result;
}
/**
 * Greedy single-step shrinking: repeatedly move to the first failing child.
 * Stops only when no direct child fails, so the result is guaranteed to be
 * irreducible by one step. The `tested` set dedups candidates across the
 * whole session and across resume boundaries via the checkpoint.
 */
function shrinkLoop(state, evaluate, serialize, budget) {
    outer: for (;;) {
        let childIndex = -1;
        for (const child of state.node.children()) {
            childIndex++;
            const key = serialize(child.value);
            if (state.tested.has(key))
                continue;
            state.tested.add(key);
            if (state.steps >= budget)
                return; // paused; checkpoint carries `tested`
            state.steps++;
            const r = evaluate(child.value, "shrink");
            if (r.outcome !== "pass") {
                state.node = child;
                state.nodeOutcome = r;
                state.path.push(childIndex);
                continue outer;
            }
        }
        state.done = true;
        return;
    }
}
function buildResult(seed, numRuns, trace, evaluations, state) {
    const kind = state.nodeOutcome.outcome === "exception" ? "exception" : "failure";
    return {
        status: kind === "exception" ? "error" : "failed",
        seed,
        numRuns,
        evaluations,
        trace,
        counterexample: state.node.value,
        counterexampleKind: kind,
        ...(state.nodeOutcome.error !== undefined ? { errorMessage: state.nodeOutcome.error } : {}),
        shrinkSteps: state.steps,
        isMinimal: state.done,
    };
}
