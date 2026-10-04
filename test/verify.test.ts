import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BuildCache } from "../src/cache.js";
import { MemoryFileStore } from "../src/store.js";

function pipeline() {
  const store = new MemoryFileStore();
  store.write("src/main", "main-v1");
  store.write("src/util", "util-v1");
  const cache = new BuildCache(store);
  cache.define("parse:main", (ctx) => `ast(${ctx.readFile("src/main")})`);
  cache.define("parse:util", (ctx) => `ast(${ctx.readFile("src/util")})`);
  cache.define("compile", async (ctx) => `obj[${await ctx.read("parse:main")}|${await ctx.read("parse:util")}]`);
  cache.define("link", async (ctx) => `bin{${await ctx.read("compile")}}`);
  return { store, cache };
}

describe("full-graph recomputation check", () => {
  test("clean incremental state verifies ok", async () => {
    const { store, cache } = pipeline();
    await cache.build("link");

    // Batch change + invalidation + incremental rebuild, then verify.
    store.write("src/main", "main-v2");
    store.write("src/util", "util-v2");
    cache.invalidate(["src/main", "src/util"]);
    await cache.build("link");

    const report = await cache.verify();
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.ok, true);
    assert.equal(cache.getEntry("link")?.value, "bin{obj[ast(main-v2)|ast(util-v2)]}");
  });

  test("stale values caused by untracked state are detected", async () => {
    const store = new MemoryFileStore();
    store.write("name", "world");
    const cache = new BuildCache(store);
    let suffix = "!"; // untracked external state, not part of any dependency
    cache.define("greet", (ctx) => `hello ${ctx.readFile("name")}${suffix}`);
    cache.define("shout", async (ctx) => (await ctx.read<string>("greet")).toUpperCase());

    await cache.build("shout");
    suffix = "???"; // changes the build result without any invalidation

    const report = await cache.verify();
    assert.equal(report.ok, false);
    const greet = report.mismatches.find((m) => m.key === "greet");
    assert.ok(greet);
    assert.equal(greet.kind, "value");
    // Downstream artifacts computed from the stale value are flagged too.
    assert.ok(report.mismatches.some((m) => m.key === "shout" && m.kind === "value"));
  });

  test("dependency-set drift is detected", async () => {
    const store = new MemoryFileStore();
    store.write("base", "b");
    store.write("extra", "e");
    const cache = new BuildCache(store);
    let withExtra = false; // untracked flag controlling which files are read
    cache.define("agg", (ctx) => {
      const parts = [ctx.readFile("base")];
      if (withExtra) parts.push(ctx.readFile("extra"));
      return parts.join("+");
    });

    await cache.build("agg");
    withExtra = true;

    const report = await cache.verify();
    assert.equal(report.ok, false);
    const kinds = report.mismatches.filter((m) => m.key === "agg").map((m) => m.kind);
    assert.ok(kinds.includes("deps"), `expected a deps mismatch, got: ${JSON.stringify(report.mismatches)}`);
  });

  test("verify() leaves the incremental cache untouched", async () => {
    const { cache } = pipeline();
    await cache.build("link");
    const before = cache.getEntry("link");
    await cache.verify();
    assert.equal(cache.getEntry("link"), before, "same entry object, nothing republished");
  });

  test("verify() reports cycles with evidence", async () => {
    const store = new MemoryFileStore();
    store.write("cap", "4");
    const cache = new BuildCache(store);
    cache.define<number>("a", async (ctx) => Math.min((await ctx.read<number>("b")) + 1, Number(ctx.readFile("cap"))), { seed: () => 0 });
    cache.define<number>("b", async (ctx) => Math.min((await ctx.read<number>("a")) + 1, Number(ctx.readFile("cap"))), { seed: () => 0 });
    await cache.build("a");

    const report = await cache.verify();
    assert.equal(report.ok, true);
    assert.equal(report.cycles.length, 1);
    assert.deepEqual(report.cycles[0]?.members, ["a", "b"]);
    const evidence = report.cycles[0]?.evidence as string[];
    assert.equal(evidence[0], evidence[evidence.length - 1]);
  });
});
