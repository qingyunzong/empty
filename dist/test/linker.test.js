"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const linker_1 = require("../src/linker");
const format_1 = require("../src/format");
function diagnosticsOfType(diagnostics, type) {
    return diagnostics.filter((d) => d.type === type);
}
(0, node_test_1.test)("local explicit export resolves to its own module", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "foo" }] },
    ];
    const result = (0, linker_1.link)(modules);
    const foo = result.exports.get("a.ts").get("foo");
    strict_1.default.deepEqual(foo.origin, { module: "a.ts", name: "foo" });
    strict_1.default.deepEqual(foo.path, ["a.ts"]);
    strict_1.default.deepEqual(result.diagnostics, []);
});
(0, node_test_1.test)("aliased re-export keeps the origin binding and records the path", () => {
    const modules = [
        { path: "x.ts", exports: [{ exportedName: "a" }] },
        {
            path: "y.ts",
            exports: [{ exportedName: "b", source: "x.ts", importedName: "a" }],
        },
    ];
    const result = (0, linker_1.link)(modules);
    const b = result.exports.get("y.ts").get("b");
    strict_1.default.deepEqual(b.origin, { module: "x.ts", name: "a" });
    strict_1.default.deepEqual(b.path, ["y.ts", "x.ts"]);
    strict_1.default.deepEqual(result.diagnostics, []);
});
(0, node_test_1.test)("explicit export takes priority over a conflicting star export", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "foo" }] },
        {
            path: "b.ts",
            exports: [{ exportedName: "foo" }],
            starExports: ["a.ts"],
        },
    ];
    const result = (0, linker_1.link)(modules);
    const foo = result.exports.get("b.ts").get("foo");
    strict_1.default.deepEqual(foo.origin, { module: "b.ts", name: "foo" });
    strict_1.default.deepEqual(diagnosticsOfType(result.diagnostics, "ambiguous-star-export"), []);
});
(0, node_test_1.test)("same name from different bindings via star exports is ambiguous", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "foo" }] },
        { path: "b.ts", exports: [{ exportedName: "foo" }] },
        { path: "c.ts", starExports: ["a.ts", "b.ts"] },
    ];
    const result = (0, linker_1.link)(modules);
    const ambiguous = diagnosticsOfType(result.diagnostics, "ambiguous-star-export");
    strict_1.default.equal(ambiguous.length, 1);
    strict_1.default.equal(ambiguous[0].module, "c.ts");
    strict_1.default.equal(ambiguous[0].name, "foo");
    strict_1.default.deepEqual(ambiguous[0].origins, [
        { module: "a.ts", name: "foo" },
        { module: "b.ts", name: "foo" },
    ]);
    // Ambiguous names are not exported.
    strict_1.default.equal(result.exports.get("c.ts").has("foo"), false);
});
(0, node_test_1.test)("same binding arriving via multiple paths is not ambiguous", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "foo" }] },
        { path: "b.ts", starExports: ["a.ts"] },
        { path: "c.ts", starExports: ["a.ts", "b.ts"] },
    ];
    const result = (0, linker_1.link)(modules);
    strict_1.default.deepEqual(diagnosticsOfType(result.diagnostics, "ambiguous-star-export"), []);
    const foo = result.exports.get("c.ts").get("foo");
    strict_1.default.deepEqual(foo.origin, { module: "a.ts", name: "foo" });
    // Shortest path wins.
    strict_1.default.deepEqual(foo.path, ["c.ts", "a.ts"]);
});
(0, node_test_1.test)("star export chains propagate source paths transitively", () => {
    const modules = [
        { path: "base.ts", exports: [{ exportedName: "core" }] },
        { path: "mid.ts", starExports: ["base.ts"] },
        { path: "top.ts", starExports: ["mid.ts"] },
    ];
    const result = (0, linker_1.link)(modules);
    const core = result.exports.get("top.ts").get("core");
    strict_1.default.deepEqual(core.origin, { module: "base.ts", name: "core" });
    strict_1.default.deepEqual(core.path, ["top.ts", "mid.ts", "base.ts"]);
});
(0, node_test_1.test)("cyclic star exports converge to a fixed point", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "fromA" }], starExports: ["b.ts"] },
        { path: "b.ts", exports: [{ exportedName: "fromB" }], starExports: ["a.ts"] },
    ];
    const result = (0, linker_1.link)(modules, { trace: true });
    strict_1.default.ok(result.rounds > 1, "expected multiple rounds for a cyclic graph");
    for (const mod of ["a.ts", "b.ts"]) {
        const entries = result.exports.get(mod);
        strict_1.default.deepEqual(entries.get("fromA").origin, { module: "a.ts", name: "fromA" });
        strict_1.default.deepEqual(entries.get("fromB").origin, { module: "b.ts", name: "fromB" });
    }
    strict_1.default.deepEqual(result.diagnostics, []);
    // Reference verification: the last two snapshots are identical (fixed point).
    const snapshots = result.snapshots;
    const last = snapshots[snapshots.length - 1].exports;
    strict_1.default.deepEqual(last, result.exports);
});
(0, node_test_1.test)("every round grows monotonically over its reference round", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "x" }], starExports: ["b.ts"] },
        { path: "b.ts", exports: [{ exportedName: "y" }], starExports: ["c.ts"] },
        { path: "c.ts", exports: [{ exportedName: "z" }], starExports: ["a.ts"] },
    ];
    const result = (0, linker_1.link)(modules, { trace: true });
    const snapshots = result.snapshots;
    for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1].exports;
        const curr = snapshots[i].exports;
        for (const [mod, entries] of prev) {
            for (const [name, info] of entries) {
                const nextInfo = curr.get(mod).get(name);
                strict_1.default.ok(nextInfo, `${mod}:${name} disappeared in round ${i}`);
                strict_1.default.deepEqual(nextInfo.origin, info.origin, "origins must be stable");
            }
        }
    }
    // Converged cycle: every module re-exports every binding.
    for (const mod of ["a.ts", "b.ts", "c.ts"]) {
        strict_1.default.deepEqual([...result.exports.get(mod).keys()].sort(), ["x", "y", "z"]);
    }
});
(0, node_test_1.test)("re-export of a missing name is reported after convergence", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "real" }] },
        { path: "b.ts", exports: [{ exportedName: "ghost", source: "a.ts", importedName: "nope" }] },
    ];
    const result = (0, linker_1.link)(modules);
    const unresolved = diagnosticsOfType(result.diagnostics, "unresolved-reexport");
    strict_1.default.equal(unresolved.length, 1);
    strict_1.default.equal(unresolved[0].exportedName, "ghost");
    strict_1.default.equal(unresolved[0].importedName, "nope");
    strict_1.default.equal(result.exports.get("b.ts").has("ghost"), false);
});
(0, node_test_1.test)("unknown star target module is reported", () => {
    const modules = [
        { path: "a.ts", starExports: ["missing.ts"] },
    ];
    const result = (0, linker_1.link)(modules);
    const unknown = diagnosticsOfType(result.diagnostics, "unknown-module");
    strict_1.default.equal(unknown.length, 1);
    strict_1.default.equal(unknown[0].source, "missing.ts");
});
(0, node_test_1.test)("report prints exports with source paths and diagnostics", () => {
    const modules = [
        { path: "a.ts", exports: [{ exportedName: "foo" }] },
        { path: "b.ts", exports: [{ exportedName: "foo" }] },
        { path: "c.ts", starExports: ["a.ts", "b.ts"] },
    ];
    const report = (0, format_1.formatReport)((0, linker_1.link)(modules));
    strict_1.default.ok(report.includes("== a.ts =="));
    strict_1.default.ok(report.includes("foo -> a.ts#foo (via a.ts)"));
    strict_1.default.ok(report.includes("[ambiguous-star-export] c.ts"));
});
