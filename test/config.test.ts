import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigStore,
  CycleError,
  MissingKeyError,
  UnterminatedPlaceholderError,
} from "../src/config";

describe("recursive expansion", () => {
  test("expands ${key} transitively", () => {
    const cfg = new ConfigStore({
      home: "/srv/app",
      confdir: "${home}/config",
      db: "sqlite://${confdir}/app.db",
    });
    assert.equal(cfg.get("db"), "sqlite:///srv/app/config/app.db");
    assert.equal(cfg.get("confdir"), "/srv/app/config");
  });

  test("expands multiple placeholders in one value", () => {
    const cfg = new ConfigStore({ a: "1", b: "2", c: "${a}-${b}-${a}" });
    assert.equal(cfg.get("c"), "1-2-1");
  });

  test("value without placeholders is returned as-is", () => {
    const cfg = new ConfigStore({ a: "plain $ and { } text" });
    assert.equal(cfg.get("a"), "plain $ and { } text");
  });
});

describe("missing keys", () => {
  test("throws MissingKeyError instead of substituting an empty string", () => {
    const cfg = new ConfigStore({ a: "x${nope}y" });
    assert.throws(() => cfg.get("a"), (err: unknown) => err instanceof MissingKeyError);
  });

  test("error message carries the resolution chain", () => {
    const cfg = new ConfigStore({ a: "${b}", b: "${gone}" });
    assert.throws(() => cfg.get("a"), /missing key "gone" \(resolving a -> b -> gone\)/);
  });

  test("getting an unknown top-level key throws", () => {
    const cfg = new ConfigStore();
    assert.throws(() => cfg.get("nope"), MissingKeyError as unknown as RegExp);
  });
});

describe("escaping", () => {
  test("\\${key} stays a literal placeholder", () => {
    const cfg = new ConfigStore({ a: "REAL", b: "\\${a}" });
    assert.equal(cfg.get("b"), "${a}");
  });

  test("escaped placeholder is not re-expanded", () => {
    const cfg = new ConfigStore({ a: "${b}", b: "loop", c: "\\${a}" });
    assert.equal(cfg.get("c"), "${a}");
  });

  test("backslash before a non-$ char is kept literally", () => {
    const cfg = new ConfigStore({ a: "C:\\temp\\file" });
    assert.equal(cfg.get("a"), "C:\\temp\\file");
  });

  test("backslash directly before a placeholder escapes it even in paths", () => {
    const cfg = new ConfigStore({ a: "C:\\temp\\${missing}" });
    assert.equal(cfg.get("a"), "C:\\temp${missing}");
  });

  test("unterminated placeholder is an error", () => {
    const cfg = new ConfigStore({ a: "open ${oops" });
    assert.throws(() => cfg.get("a"), UnterminatedPlaceholderError as unknown as RegExp);
  });
});

describe("cycle detection", () => {
  test("direct self reference reports path from the requested key", () => {
    const cfg = new ConfigStore({ a: "${a}" });
    assert.throws(
      () => cfg.get("a"),
      (err: unknown) => err instanceof CycleError && (err as CycleError).message === "circular reference: a -> a",
    );
  });

  test("indirect cycle path starts at the requested key", () => {
    const cfg = new ConfigStore({ a: "${b}", b: "${c}", c: "${a}" });
    try {
      cfg.get("a");
      assert.ok(false, "expected CycleError");
    } catch (err) {
      assert.ok(err instanceof CycleError);
      assert.deepEqual((err as CycleError).path, ["a", "b", "c", "a"]);
      assert.equal((err as Error).message, "circular reference: a -> b -> c -> a");
    }
  });

  test("cycle not containing the requested key still reports full path from it", () => {
    const cfg = new ConfigStore({ a: "prefix-${b}", b: "${c}", c: "${b}" });
    assert.throws(
      () => cfg.get("a"),
      (err: unknown) => err instanceof CycleError && (err as CycleError).message === "circular reference: a -> b -> c -> b",
    );
  });
});

describe("versioned dependency cache", () => {
  test("results are cached and recomputed only after a dependency changes", () => {
    const cfg = new ConfigStore({ a: "1", b: "${a}", c: "${b}", d: "static" });
    assert.equal(cfg.get("c"), "1");
    assert.equal(cfg.get("d"), "static");
    assert.equal(cfg.computeCounts.get("c"), 1);
    assert.equal(cfg.computeCounts.get("d"), 1);
    cfg.get("c");
    cfg.get("d");
    assert.equal(cfg.computeCounts.get("c"), 1, "c served from cache");
    assert.equal(cfg.computeCounts.get("d"), 1, "d served from cache");
  });

  test("modifying a key invalidates only its dependents", () => {
    const cfg = new ConfigStore({ a: "1", b: "${a}!", c: "${b}!", d: "solo", e: "${d}!" });
    for (const key of ["a", "b", "c", "d", "e"]) cfg.get(key);
    cfg.set("a", "2");
    cfg.get("c");
    cfg.get("e");
    assert.equal(cfg.get("c"), "2!!");
    assert.equal(cfg.computeCounts.get("b"), 2, "b depends on a");
    assert.equal(cfg.computeCounts.get("c"), 2, "c depends on a transitively");
    assert.equal(cfg.computeCounts.get("d"), 1, "d untouched");
    assert.equal(cfg.computeCounts.get("e"), 1, "e does not depend on a");
  });

  test("deleting a key invalidates dependents and surfaces MissingKeyError", () => {
    const cfg = new ConfigStore({ a: "1", b: "${a}" });
    assert.equal(cfg.get("b"), "1");
    cfg.delete("a");
    assert.throws(() => cfg.get("b"), (err: unknown) => err instanceof MissingKeyError);
  });

  test("cached resolution always matches uncached resolution across mutations", () => {
    const cfg = new ConfigStore({
      host: "example.com",
      port: "8080",
      base: "http://${host}:${port}",
      api: "${base}/v1",
      health: "${api}/health",
      static1: "no refs here",
      esc: "\\${host}",
    });
    const keys = ["host", "port", "base", "api", "health", "static1", "esc"];
    const checkAll = () => {
      for (const key of keys) {
        assert.equal(cfg.get(key), cfg.resolveUncached(key), `mismatch on ${key}`);
      }
    };
    checkAll();
    cfg.set("host", "internal.lan");
    checkAll();
    assert.equal(cfg.get("health"), "http://internal.lan:8080/v1/health");
    cfg.set("port", "9090");
    checkAll();
    cfg.set("base", "https://${host}");
    checkAll();
    assert.equal(cfg.get("api"), "https://internal.lan/v1");
    cfg.set("host", "again.example");
    checkAll();
    assert.equal(cfg.get("health"), "https://again.example/v1/health");
  });

  test("cached and uncached agree on errors too", () => {
    const cfg = new ConfigStore({ a: "${b}", b: "${a}", c: "${missing}" });
    for (const key of ["a", "c"]) {
      let cachedErr: unknown;
      let uncachedErr: unknown;
      try { cfg.get(key); } catch (err) { cachedErr = err; }
      try { cfg.resolveUncached(key); } catch (err) { uncachedErr = err; }
      assert.equal((cachedErr as Error).constructor, (uncachedErr as Error).constructor);
      assert.equal((cachedErr as Error).message, (uncachedErr as Error).message);
    }
  });
});
