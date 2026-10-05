import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Compiler, fullCompile } from "../src/compiler.js";
import { InMemoryStore } from "../src/store.js";
import { makeBaseline, resumeBaseline } from "../src/baseline.js";
/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomState(rand, size) {
    const state = { modules: new Map(), nextId: 0 };
    for (let i = 0; i < size; i += 1)
        addModule(rand, state);
    const names = [...state.modules.keys()];
    for (const name of names) {
        for (const other of names) {
            if (other !== name && rand() < 0.2)
                addEdge(state, name, other);
        }
    }
    return state;
}
function addModule(rand, state) {
    const name = `m${state.nextId}`;
    state.nextId += 1;
    state.modules.set(name, {
        name,
        iface: `export const v_${name} = ${Math.floor(rand() * 1e6)}`,
        impl: `body ${name} ${Math.floor(rand() * 1e6)}`,
        imports: [],
    });
    return name;
}
function addEdge(state, from, to) {
    const m = state.modules.get(from);
    if (from === to || m.imports.includes(to))
        return;
    state.modules.set(from, { ...m, imports: [...m.imports, to] });
}
function removeEdge(state, from, to) {
    const m = state.modules.get(from);
    state.modules.set(from, { ...m, imports: m.imports.filter((i) => i !== to) });
}
function removeModule(state, name) {
    state.modules.delete(name);
    for (const [n, m] of state.modules) {
        if (m.imports.includes(name))
            removeEdge(state, n, name);
    }
}
function randomEdit(rand, state) {
    const names = [...state.modules.keys()];
    if (names.length === 0)
        return null;
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const roll = rand();
    if (roll < 0.35) {
        const name = pick(names);
        const m = state.modules.get(name);
        state.modules.set(name, { ...m, impl: `${m.impl} // edit ${Math.floor(rand() * 1e6)}` });
        return { kind: "impl", name };
    }
    if (roll < 0.55) {
        const name = pick(names);
        const m = state.modules.get(name);
        state.modules.set(name, { ...m, iface: `${m.iface}; export const e${Math.floor(rand() * 1e6)}` });
        return { kind: "iface", name };
    }
    if (roll < 0.7 && names.length > 1) {
        addEdge(state, pick(names), pick(names));
        return { kind: "addEdge" };
    }
    if (roll < 0.8) {
        const from = pick(names);
        const imports = state.modules.get(from).imports;
        if (imports.length > 0)
            removeEdge(state, from, pick(imports));
        return { kind: "removeEdge" };
    }
    if (roll < 0.9 && names.length < 16) {
        const name = addModule(rand, state);
        if (names.length > 0 && rand() < 0.7)
            addEdge(state, name, pick(names));
        return { kind: "addModule" };
    }
    if (names.length > 2) {
        removeModule(state, pick(names));
        return { kind: "removeModule" };
    }
    return null;
}
function sourcesOf(state) {
    return [...state.modules.values()];
}
function artifactsOf(result) {
    return [...result.artifacts.entries()].sort(([a], [b]) => a.localeCompare(b));
}
function componentOf(result, moduleName) {
    const plan = result.plans.find((p) => p.members.includes(moduleName));
    if (!plan)
        throw new Error(`no component for ${moduleName}`);
    return plan.id;
}
test("random edits: incremental cache matches full-compile model", () => {
    const SEEDS = 25;
    const EDITS_PER_SEED = 30;
    let implOnlyChecks = 0;
    let ifacePropagationChecks = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
        const rand = rng(seed * 7919);
        const state = randomState(rand, 8);
        const store = new InMemoryStore();
        const compiler = new Compiler(store);
        let previous = compiler.build(sourcesOf(state));
        for (let step = 0; step < EDITS_PER_SEED; step += 1) {
            const edit = randomEdit(rand, state);
            const sources = sourcesOf(state);
            const incremental = compiler.build(sources);
            const full = fullCompile(sources, new InMemoryStore());
            // 1. incremental result must equal the from-scratch model
            deepEqual(artifactsOf(incremental), artifactsOf(full), `seed=${seed} step=${step} edit=${edit?.kind}`);
            // 2. a resumed baseline must verify cleanly against the store
            const report = resumeBaseline(makeBaseline(incremental), store);
            ok(report.ok, `seed=${seed} step=${step}: ${report.problems.join("; ")}`);
            // 3. structural minimality guarantees per edit kind
            if (edit?.kind === "impl") {
                const expected = componentOf(previous, edit.name);
                deepEqual(incremental.compiled, [expected], `impl-only edit must recompile only its own component`);
                implOnlyChecks += 1;
            }
            if (edit?.kind === "iface") {
                const own = componentOf(previous, edit.name);
                const expected = new Set([own]);
                for (const s of previous.summaries) {
                    const importer = componentOf(previous, s.name);
                    if (importer !== own && s.imports.includes(edit.name)) {
                        expected.add(importer);
                    }
                }
                deepEqual([...incremental.compiled].sort(), [...expected].sort(), `iface edit must recompile exactly the component and its direct dependents`);
                ifacePropagationChecks += 1;
            }
            previous = incremental;
        }
        // 4. quiescence: rebuilding with no edits compiles nothing
        const idle = compiler.build(sourcesOf(state));
        equal(idle.compiled.length, 0, `seed=${seed}: quiescent rebuild must be a no-op`);
    }
    ok(implOnlyChecks > 0, "expected impl-only edits to be exercised");
    ok(ifacePropagationChecks > 0, "expected iface edits to be exercised");
    console.log(`random cross-check: ${SEEDS} seeds x ${EDITS_PER_SEED} edits, ` +
        `${implOnlyChecks} impl-only checks, ${ifacePropagationChecks} iface-propagation checks`);
});
