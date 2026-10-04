import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildCache } from "../src/cache";

test("cached results are published only after input-version checks", () => {
  const cache = new BuildCache();
  cache.setSource("a", "1");
  cache.registerTask("A", (ctx) => `A(${ctx.read("a")})`);

  assert.equal(cache.build("A"), "A(1)");
  assert.equal(cache.runCounts.get("A"), 1);

  // No change: versions match, cached record is published without re-running.
  assert.equal(cache.build("A"), "A(1)");
  assert.equal(cache.runCounts.get("A"), 1);

  // Input version changed: stale record must not be published.
  cache.setSource("a", "2");
  assert.equal(cache.build("A"), "A(2)");
  assert.equal(cache.runCounts.get("A"), 2);
});

test("batch changes invalidate only the reverse-reachable closure", () => {
  const cache = new BuildCache();
  cache.setSource("a", "a0");
  cache.setSource("b", "b0");
  cache.registerTask("A", (ctx) => `A<${ctx.read("a")}>`);
  cache.registerTask("B", (ctx) => `B<${ctx.read("b")}>`);
  cache.registerTask("C", (ctx) => `C[${ctx.read("A")}]`);

  cache.build("C");
  cache.build("B");
  assert.equal(cache.runCounts.get("A"), 1);
  assert.equal(cache.runCounts.get("B"), 1);
  assert.equal(cache.runCounts.get("C"), 1);

  // Batch change of a and b: each dependent rebuilds exactly once.
  cache.setSource("a", "a1");
  cache.setSource("b", "b1");
  assert.equal(cache.build("C"), "C[A<a1>]");
  assert.equal(cache.build("B"), "B<b1>");
  assert.equal(cache.runCounts.get("A"), 2);
  assert.equal(cache.runCounts.get("B"), 2);
  assert.equal(cache.runCounts.get("C"), 2);

  // Changing only `a` invalidates the closure {a, A, C}; B stays cached.
  cache.setSource("a", "a2");
  cache.build("C");
  cache.build("B");
  assert.equal(cache.runCounts.get("A"), 3);
  assert.equal(cache.runCounts.get("C"), 3);
  assert.equal(cache.runCounts.get("B"), 2);

  // The invalidated set is exactly the reverse-reachable closure.
  cache.setSource("b", "b2");
  const affected = cache.invalidate();
  assert.deepEqual([...affected].sort(), ["B", "b"]);
});

test("dependencies may change during rebuild; stale edges stop invalidating", () => {
  const cache = new BuildCache();
  cache.setSource("cfg", "x");
  cache.setSource("x", "x0");
  cache.setSource("y", "y0");
  cache.registerTask("T", (ctx) => {
    const name = ctx.read("cfg") as string;
    return `T=${ctx.read(name)}`;
  });

  assert.equal(cache.build("T"), "T=x0");
  assert.deepEqual([...cache.depsOf("T")].sort(), ["cfg", "x"]);

  // Rebuild changes T's dependency edge from x to y.
  cache.setSource("cfg", "y");
  assert.equal(cache.build("T"), "T=y0");
  assert.deepEqual([...cache.depsOf("T")].sort(), ["cfg", "y"]);
  assert.equal(cache.runCounts.get("T"), 2);

  // The old dependency x no longer invalidates T.
  cache.setSource("x", "x1");
  assert.equal(cache.build("T"), "T=y0");
  assert.equal(cache.runCounts.get("T"), 2);

  // The new dependency y does.
  cache.setSource("y", "y1");
  assert.equal(cache.build("T"), "T=y1");
  assert.equal(cache.runCounts.get("T"), 3);
});

test("cyclic dependencies converge and cycle evidence is reported", () => {
  const cache = new BuildCache();
  cache.setSource("base", ["a"]);
  cache.registerTask("A", (ctx) => {
    const fromB = (ctx.read("B") as string[] | undefined) ?? [];
    const base = ctx.read("base") as string[];
    return [...new Set([...base, ...fromB])].sort();
  });
  cache.registerTask("B", (ctx) => {
    const fromA = (ctx.read("A") as string[] | undefined) ?? [];
    return [...new Set(["b", ...fromA])].sort();
  });

  assert.deepEqual(cache.build("A"), ["a", "b"]);
  assert.deepEqual(cache.build("B"), ["a", "b"]);

  const cycles = cache.cycles();
  assert.equal(cycles.length, 1);
  const cycle = cycles[0];
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  assert.ok(cycle.includes("A") && cycle.includes("B"));

  // Converged: rebuilding without changes runs nothing.
  const runsA = cache.runCounts.get("A")!;
  const runsB = cache.runCounts.get("B")!;
  cache.build("A");
  assert.equal(cache.runCounts.get("A"), runsA);
  assert.equal(cache.runCounts.get("B"), runsB);
});

test("non-convergent cycles fail with cycle evidence", () => {
  const cache = new BuildCache({ maxFixpointRounds: 8 });
  cache.registerTask("X", (ctx) => `${ctx.read("Y")}>`);
  cache.registerTask("Y", (ctx) => `${ctx.read("X")}<`);
  assert.throws(() => cache.build("X"), /did not converge.*cycle evidence: [XY] -> [XY] -> [XY]/);
});

test("full-graph recompute verifies incremental results", () => {
  const cache = new BuildCache();
  cache.setSource("a", "1");
  cache.setSource("b", "2");
  cache.registerTask("A", (ctx) => `A(${ctx.read("a")})`);
  cache.registerTask("B", (ctx) => `B(${ctx.read("b")})`);
  cache.registerTask("C", (ctx) => `C(${ctx.read("A")},${ctx.read("B")})`);

  cache.build("C");
  cache.setSource("a", "1x");
  cache.build("C");
  cache.setSource("b", "2x");
  cache.build("C");

  const report = cache.verify();
  assert.equal(report.consistent, true);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual([...report.checked].sort(), ["A", "B", "C"]);
});

test("full-graph recompute detects non-reproducible tasks", () => {
  const cache = new BuildCache();
  let counter = 0;
  cache.registerTask("N", () => `n-${counter++}`);
  cache.build("N");

  const report = cache.verify();
  assert.equal(report.consistent, false);
  assert.deepEqual(report.mismatches, ["N"]);
});

test("tracks file-to-artifact dependencies via the filesystem", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-cache-"));
  const header = join(dir, "header.txt");
  const main = join(dir, "main.txt");
  writeFileSync(header, "H0");
  writeFileSync(main, "M0");

  const cache = new BuildCache();
  cache.setSourceFile("header", header);
  cache.setSourceFile("main", main);
  cache.registerTask("out", (ctx) => `${ctx.read("header")}+${ctx.read("main")}`);

  assert.equal(cache.build("out"), "H0+M0");
  assert.equal(cache.runCounts.get("out"), 1);

  writeFileSync(header, "H1");
  cache.setSourceFile("header", header);
  assert.equal(cache.build("out"), "H1+M0");
  assert.equal(cache.runCounts.get("out"), 2);
});
