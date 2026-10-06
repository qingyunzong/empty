import { test } from "node:test";
import assert from "node:assert/strict";
import { link, type Diagnostic, type ModuleSpec } from "../src/linker";
import { formatReport } from "../src/format";

function diagnosticsOfType<T extends Diagnostic["type"]>(
  diagnostics: Diagnostic[],
  type: T,
): Extract<Diagnostic, { type: T }>[] {
  return diagnostics.filter((d) => d.type === type) as Extract<Diagnostic, { type: T }>[];
}

test("local explicit export resolves to its own module", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "foo" }] },
  ];
  const result = link(modules);
  const foo = result.exports.get("a.ts")!.get("foo")!;
  assert.deepEqual(foo.origin, { module: "a.ts", name: "foo" });
  assert.deepEqual(foo.path, ["a.ts"]);
  assert.deepEqual(result.diagnostics, []);
});

test("aliased re-export keeps the origin binding and records the path", () => {
  const modules: ModuleSpec[] = [
    { path: "x.ts", exports: [{ exportedName: "a" }] },
    {
      path: "y.ts",
      exports: [{ exportedName: "b", source: "x.ts", importedName: "a" }],
    },
  ];
  const result = link(modules);
  const b = result.exports.get("y.ts")!.get("b")!;
  assert.deepEqual(b.origin, { module: "x.ts", name: "a" });
  assert.deepEqual(b.path, ["y.ts", "x.ts"]);
  assert.deepEqual(result.diagnostics, []);
});

test("explicit export takes priority over a conflicting star export", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "foo" }] },
    {
      path: "b.ts",
      exports: [{ exportedName: "foo" }],
      starExports: ["a.ts"],
    },
  ];
  const result = link(modules);
  const foo = result.exports.get("b.ts")!.get("foo")!;
  assert.deepEqual(foo.origin, { module: "b.ts", name: "foo" });
  assert.deepEqual(diagnosticsOfType(result.diagnostics, "ambiguous-star-export"), []);
});

test("same name from different bindings via star exports is ambiguous", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "foo" }] },
    { path: "b.ts", exports: [{ exportedName: "foo" }] },
    { path: "c.ts", starExports: ["a.ts", "b.ts"] },
  ];
  const result = link(modules);
  const ambiguous = diagnosticsOfType(result.diagnostics, "ambiguous-star-export");
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0]!.module, "c.ts");
  assert.equal(ambiguous[0]!.name, "foo");
  assert.deepEqual(
    ambiguous[0]!.origins,
    [
      { module: "a.ts", name: "foo" },
      { module: "b.ts", name: "foo" },
    ],
  );
  // Ambiguous names are not exported.
  assert.equal(result.exports.get("c.ts")!.has("foo"), false);
});

test("same binding arriving via multiple paths is not ambiguous", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "foo" }] },
    { path: "b.ts", starExports: ["a.ts"] },
    { path: "c.ts", starExports: ["a.ts", "b.ts"] },
  ];
  const result = link(modules);
  assert.deepEqual(diagnosticsOfType(result.diagnostics, "ambiguous-star-export"), []);
  const foo = result.exports.get("c.ts")!.get("foo")!;
  assert.deepEqual(foo.origin, { module: "a.ts", name: "foo" });
  // Shortest path wins.
  assert.deepEqual(foo.path, ["c.ts", "a.ts"]);
});

test("star export chains propagate source paths transitively", () => {
  const modules: ModuleSpec[] = [
    { path: "base.ts", exports: [{ exportedName: "core" }] },
    { path: "mid.ts", starExports: ["base.ts"] },
    { path: "top.ts", starExports: ["mid.ts"] },
  ];
  const result = link(modules);
  const core = result.exports.get("top.ts")!.get("core")!;
  assert.deepEqual(core.origin, { module: "base.ts", name: "core" });
  assert.deepEqual(core.path, ["top.ts", "mid.ts", "base.ts"]);
});

test("cyclic star exports converge to a fixed point", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "fromA" }], starExports: ["b.ts"] },
    { path: "b.ts", exports: [{ exportedName: "fromB" }], starExports: ["a.ts"] },
  ];
  const result = link(modules, { trace: true });
  assert.ok(result.rounds > 1, "expected multiple rounds for a cyclic graph");
  for (const mod of ["a.ts", "b.ts"] as const) {
    const entries = result.exports.get(mod)!;
    assert.deepEqual(entries.get("fromA")!.origin, { module: "a.ts", name: "fromA" });
    assert.deepEqual(entries.get("fromB")!.origin, { module: "b.ts", name: "fromB" });
  }
  assert.deepEqual(result.diagnostics, []);

  // Reference verification: the last two snapshots are identical (fixed point).
  const snapshots = result.snapshots!;
  const last = snapshots[snapshots.length - 1]!.exports;
  assert.deepEqual(last, result.exports);
});

test("every round grows monotonically over its reference round", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "x" }], starExports: ["b.ts"] },
    { path: "b.ts", exports: [{ exportedName: "y" }], starExports: ["c.ts"] },
    { path: "c.ts", exports: [{ exportedName: "z" }], starExports: ["a.ts"] },
  ];
  const result = link(modules, { trace: true });
  const snapshots = result.snapshots!;
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!.exports;
    const curr = snapshots[i]!.exports;
    for (const [mod, entries] of prev) {
      for (const [name, info] of entries) {
        const nextInfo = curr.get(mod)!.get(name)!;
        assert.ok(nextInfo, `${mod}:${name} disappeared in round ${i}`);
        assert.deepEqual(nextInfo.origin, info.origin, "origins must be stable");
      }
    }
  }
  // Converged cycle: every module re-exports every binding.
  for (const mod of ["a.ts", "b.ts", "c.ts"] as const) {
    assert.deepEqual(
      [...result.exports.get(mod)!.keys()].sort(),
      ["x", "y", "z"],
    );
  }
});

test("re-export of a missing name is reported after convergence", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "real" }] },
    { path: "b.ts", exports: [{ exportedName: "ghost", source: "a.ts", importedName: "nope" }] },
  ];
  const result = link(modules);
  const unresolved = diagnosticsOfType(result.diagnostics, "unresolved-reexport");
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]!.exportedName, "ghost");
  assert.equal(unresolved[0]!.importedName, "nope");
  assert.equal(result.exports.get("b.ts")!.has("ghost"), false);
});

test("unknown star target module is reported", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", starExports: ["missing.ts"] },
  ];
  const result = link(modules);
  const unknown = diagnosticsOfType(result.diagnostics, "unknown-module");
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.source, "missing.ts");
});

test("report prints exports with source paths and diagnostics", () => {
  const modules: ModuleSpec[] = [
    { path: "a.ts", exports: [{ exportedName: "foo" }] },
    { path: "b.ts", exports: [{ exportedName: "foo" }] },
    { path: "c.ts", starExports: ["a.ts", "b.ts"] },
  ];
  const report = formatReport(link(modules));
  assert.ok(report.includes("== a.ts =="));
  assert.ok(report.includes("foo -> a.ts#foo (via a.ts)"));
  assert.ok(report.includes("[ambiguous-star-export] c.ts"));
});
