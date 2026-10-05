import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Compiler } from "../src/compiler.js";
import { InMemoryStore } from "../src/store.js";
import { makeBaseline, resumeBaseline } from "../src/baseline.js";
import type { ModuleSource } from "../src/summaries.js";

function mod(
  name: string,
  imports: string[] = [],
  iface = `export interface ${name}`,
  impl = `impl of ${name}`,
): ModuleSource {
  return { name, imports, iface, impl };
}

test("interface unchanged -> only the edited module recompiles", () => {
  const store = new InMemoryStore();
  const compiler = new Compiler(store);
  const base = [
    mod("app", ["lib"]),
    mod("lib", ["core"]),
    mod("core"),
  ];
  const first = compiler.build(base);
  deepEqual([...first.compiled].sort(), ["app", "core", "lib"]);

  // impl-only edit in the middle of the chain
  const edited = base.map((m) =>
    m.name === "lib" ? { ...m, impl: "impl of lib v2" } : m,
  );
  const second = compiler.build(edited);
  deepEqual(second.compiled, ["lib"]);
  deepEqual([...second.reused].sort(), ["app", "core"]);
  // lib's artifact changed, dependents kept theirs
  ok(second.artifacts.get("lib") !== first.artifacts.get("lib"));
  equal(second.artifacts.get("app"), first.artifacts.get("app"));
});

test("interface change propagates to dependents only", () => {
  const store = new InMemoryStore();
  const compiler = new Compiler(store);
  const base = [
    mod("app", ["lib"]),
    mod("cli", ["lib"]),
    mod("lib", ["core"]),
    mod("core"),
    mod("unrelated"),
  ];
  compiler.build(base);

  const edited = base.map((m) =>
    m.name === "lib" ? { ...m, iface: "export interface lib v2" } : m,
  );
  const result = compiler.build(edited);
  deepEqual([...result.compiled].sort(), ["app", "cli", "lib"]);
  deepEqual([...result.reused].sort(), ["core", "unrelated"]);
});

test("cyclic modules are published as one SCC batch", () => {
  const store = new InMemoryStore();
  const compiler = new Compiler(store);
  const base = [
    mod("a", ["b"]),
    mod("b", ["c"]),
    mod("c", ["a"]),
    mod("d", ["a"]),
  ];
  const first = compiler.build(base);
  deepEqual(first.plans.map((p) => p.id), ["a+b+c", "d"]);

  // touching one member of the cycle recompiles the whole batch
  const edited = base.map((m) =>
    m.name === "b" ? { ...m, impl: "impl of b v2" } : m,
  );
  const second = compiler.build(edited);
  deepEqual(second.compiled, ["a+b+c"]);
  deepEqual(second.reused, ["d"]);
  ok(second.artifacts.get("a+b+c") !== first.artifacts.get("a+b+c"));
});

test("rebuilding unchanged sources compiles nothing", () => {
  const store = new InMemoryStore();
  const compiler = new Compiler(store);
  const sources = [mod("x", ["y"]), mod("y")];
  compiler.build(sources);
  const second = compiler.build(sources);
  deepEqual(second.compiled, []);
  equal(second.reused.length, 2);
});

test("old task baseline verifies; corrupted store is detected and repaired", () => {
  const store = new InMemoryStore();
  const compiler = new Compiler(store);
  const sources = [mod("x", ["y"]), mod("y")];
  const baseline = makeBaseline(compiler.build(sources));

  const clean = resumeBaseline(baseline, store);
  ok(clean.ok);
  deepEqual(clean.problems, []);

  // simulate cache corruption: one artifact entry lost
  const victimKey = baseline.components["y"]!.key;
  store.delete(victimKey);
  const dirty = resumeBaseline(baseline, store);
  ok(!dirty.ok);
  deepEqual(dirty.evicted, ["y"]);

  // the next build recompiles exactly the evicted component
  const rebuilt = compiler.build(sources);
  deepEqual(rebuilt.compiled, ["y"]);
  ok(resumeBaseline(makeBaseline(rebuilt), store).ok);
});

test("tampered baseline manifest is rejected", () => {
  const store = new InMemoryStore();
  const compiler = new Compiler(store);
  const baseline = makeBaseline(compiler.build([mod("x")]));
  const tampered = {
    ...baseline,
    modules: {
      x: { ...baseline.modules["x"]!, implHash: "forged" },
    },
  };
  const report = resumeBaseline(tampered, store);
  ok(!report.ok);
  ok(report.problems.some((p) => p.includes("manifest")));
});
