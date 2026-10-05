import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  loadConfig,
  ConfigError,
  normalizePath,
  resolvePath,
} from "../src/config-loader.js";

test("relative includes resolve against the including file", () => {
  const { config } = loadConfig(
    {
      "app/main.json": JSON.stringify({
        $include: ["./base.json", "../shared/common.json"],
        name: "app",
      }),
      "app/base.json": JSON.stringify({ db: { host: "localhost" } }),
      "shared/common.json": JSON.stringify({ $include: "./nested/deep.json", level: 1 }),
      "shared/nested/deep.json": JSON.stringify({ deep: true }),
    },
    "app/main.json",
  );
  assert.deepEqual(config, {
    db: { host: "localhost" },
    level: 1,
    deep: true,
    name: "app",
  });
});

test("parent-directory includes (..) resolve correctly", () => {
  const { config } = loadConfig(
    {
      "a/b/c.json": JSON.stringify({ $include: "../../root.json", here: "c" }),
      "root.json": JSON.stringify({ fromRoot: 1 }),
    },
    "a/b/c.json",
  );
  assert.deepEqual(config, { fromRoot: 1, here: "c" });
});

test("scalar override wins and provenance records the full source chain", () => {
  const { config, provenance } = loadConfig(
    {
      "app.json": JSON.stringify({ $include: "./base.json", db: { host: "prod.db" } }),
      "base.json": JSON.stringify({ db: { host: "dev.db", port: 5432 } }),
    },
    "app.json",
  );
  assert.deepEqual(config, { db: { host: "prod.db", port: 5432 } });
  // overridden field: base first, overriding file last
  assert.deepEqual(provenance["db.host"], ["base.json", "app.json"]);
  // untouched field: only the defining file
  assert.deepEqual(provenance["db.port"], ["base.json"]);
});

test("array override replaces by default", () => {
  const { config, provenance } = loadConfig(
    {
      "app.json": JSON.stringify({ $include: "base.json", tags: ["x"] }),
      "base.json": JSON.stringify({ tags: ["a", "b"] }),
    },
    "app.json",
  );
  assert.deepEqual(config, { tags: ["x"] });
  assert.deepEqual(provenance["tags"], ["base.json", "app.json"]);
  assert.deepEqual(provenance["tags.0"], ["app.json"]);
});

test("'key+' appends arrays across files with per-element provenance", () => {
  const { config, provenance } = loadConfig(
    {
      "app.json": JSON.stringify({
        $include: ["base.json", "extra.json"],
        "plugins+": ["final"],
      }),
      "base.json": JSON.stringify({ plugins: ["a", "b"] }),
      "extra.json": JSON.stringify({ "plugins+": ["c"] }),
    },
    "app.json",
  );
  assert.deepEqual(config, { plugins: ["a", "b", "c", "final"] });
  assert.deepEqual(provenance["plugins"], ["base.json", "extra.json", "app.json"]);
  assert.deepEqual(provenance["plugins.0"], ["base.json"]);
  assert.deepEqual(provenance["plugins.2"], ["extra.json"]);
  assert.deepEqual(provenance["plugins.3"], ["app.json"]);
});

test("'key+' on a missing field creates the array", () => {
  const { config } = loadConfig(
    { "app.json": JSON.stringify({ "list+": [1, 2] }) },
    "app.json",
  );
  assert.deepEqual(config, { list: [1, 2] });
});

test("diamond includes are allowed: shared file loads once per branch", () => {
  const files = {
    "app.json": JSON.stringify({ $include: ["./b.json", "./c.json"], name: "app" }),
    "b.json": JSON.stringify({ $include: "./d.json", b: true }),
    "c.json": JSON.stringify({ $include: "./d.json", c: true }),
    "d.json": JSON.stringify({ shared: "from-d" }),
  };
  const { config, provenance } = loadConfig(files, "app.json");
  assert.deepEqual(config, { shared: "from-d", b: true, c: true, name: "app" });
  // the shared field's chain mentions d.json exactly once
  assert.deepEqual(provenance["shared"], ["d.json"]);
});

test("diamond with override: later branch overrides, chain stays ordered", () => {
  const files = {
    "app.json": JSON.stringify({ $include: ["./b.json", "./c.json"] }),
    "b.json": JSON.stringify({ $include: "./d.json", level: "b" }),
    "c.json": JSON.stringify({ $include: "./d.json", level: "c" }),
    "d.json": JSON.stringify({ level: "d" }),
  };
  const { config, provenance } = loadConfig(files, "app.json");
  assert.equal(config["level"], "c");
  assert.deepEqual(provenance["level"], ["d.json", "b.json", "c.json"]);
});

test("circular include throws with the full include path", () => {
  const files = {
    "a.json": JSON.stringify({ $include: "./b.json" }),
    "b.json": JSON.stringify({ $include: "./c.json" }),
    "c.json": JSON.stringify({ $include: "./a.json" }),
  };
  assert.throws(
    () => loadConfig(files, "a.json"),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) throw new Error("expected ConfigError");
      assert.match(err.message, /circular include/);
      assert.match(err.message, /a\.json -> b\.json -> c\.json -> a\.json/);
      assert.deepEqual(err.includeChain, ["a.json", "b.json", "c.json", "a.json"]);
      return true;
    },
  );
});

test("self include is detected as a cycle", () => {
  const files = { "a.json": JSON.stringify({ $include: "./a.json" }) };
  assert.throws(() => loadConfig(files, "a.json"), /circular include: a\.json -> a\.json/);
});

test("missing file error carries the full include path", () => {
  const files = {
    "app.json": JSON.stringify({ $include: "./dir/mid.json" }),
    "dir/mid.json": JSON.stringify({ $include: "../nope.json" }),
  };
  assert.throws(
    () => loadConfig(files, "app.json"),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) throw new Error("expected ConfigError");
      assert.match(err.message, /file not found: nope\.json/);
      assert.match(err.message, /app\.json -> dir\/mid\.json -> nope\.json/);
      return true;
    },
  );
});

test("invalid JSON error names the file and the include path", () => {
  const files = {
    "app.json": JSON.stringify({ $include: "./broken.json" }),
    "broken.json": "{ not json",
  };
  assert.throws(
    () => loadConfig(files, "app.json"),
    (err: unknown) => {
      if (!(err instanceof ConfigError)) throw new Error("expected ConfigError");
      assert.match(err.message, /invalid JSON in broken\.json/);
      assert.match(err.message, /app\.json -> broken\.json/);
      return true;
    },
  );
});

test("appending to a non-array field is an error with include path", () => {
  const files = {
    "app.json": JSON.stringify({ $include: "./base.json", "port+": [1] }),
    "base.json": JSON.stringify({ port: 5432 }),
  };
  assert.throws(
    () => loadConfig(files, "app.json"),
    /cannot append to non-array field "port".*app\.json/,
  );
});

test("deep objects merge across include levels", () => {
  const { config, provenance } = loadConfig(
    {
      "app.json": JSON.stringify({
        $include: "./base.json",
        server: { tls: { enabled: true } },
      }),
      "base.json": JSON.stringify({
        server: { host: "0.0.0.0", tls: { cert: "pem" } },
      }),
    },
    "app.json",
  );
  assert.deepEqual(config, {
    server: { host: "0.0.0.0", tls: { cert: "pem", enabled: true } },
  });
  assert.deepEqual(provenance["server.tls.cert"], ["base.json"]);
  assert.deepEqual(provenance["server.tls.enabled"], ["app.json"]);
});

test("later includes override earlier includes", () => {
  const { config, provenance } = loadConfig(
    {
      "app.json": JSON.stringify({ $include: ["./one.json", "./two.json"] }),
      "one.json": JSON.stringify({ v: "one" }),
      "two.json": JSON.stringify({ v: "two" }),
    },
    "app.json",
  );
  assert.equal(config["v"], "two");
  assert.deepEqual(provenance["v"], ["one.json", "two.json"]);
});

test("path utilities normalize and resolve virtual paths", () => {
  assert.equal(normalizePath("a/./b/../c.json"), "a/c.json");
  assert.equal(normalizePath("/a//b.json"), "/a/b.json");
  assert.equal(resolvePath("a/b/c.json", "../d.json"), "a/d.json");
  assert.equal(resolvePath("a/b/c.json", "/abs.json"), "/abs.json");
});
