"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const config_1 = require("../src/config");
(0, node_test_1.describe)("recursive expansion", () => {
    (0, node_test_1.test)("expands ${key} transitively", () => {
        const cfg = new config_1.ConfigStore({
            home: "/srv/app",
            confdir: "${home}/config",
            db: "sqlite://${confdir}/app.db",
        });
        strict_1.default.equal(cfg.get("db"), "sqlite:///srv/app/config/app.db");
        strict_1.default.equal(cfg.get("confdir"), "/srv/app/config");
    });
    (0, node_test_1.test)("expands multiple placeholders in one value", () => {
        const cfg = new config_1.ConfigStore({ a: "1", b: "2", c: "${a}-${b}-${a}" });
        strict_1.default.equal(cfg.get("c"), "1-2-1");
    });
    (0, node_test_1.test)("value without placeholders is returned as-is", () => {
        const cfg = new config_1.ConfigStore({ a: "plain $ and { } text" });
        strict_1.default.equal(cfg.get("a"), "plain $ and { } text");
    });
});
(0, node_test_1.describe)("missing keys", () => {
    (0, node_test_1.test)("throws MissingKeyError instead of substituting an empty string", () => {
        const cfg = new config_1.ConfigStore({ a: "x${nope}y" });
        strict_1.default.throws(() => cfg.get("a"), (err) => err instanceof config_1.MissingKeyError);
    });
    (0, node_test_1.test)("error message carries the resolution chain", () => {
        const cfg = new config_1.ConfigStore({ a: "${b}", b: "${gone}" });
        strict_1.default.throws(() => cfg.get("a"), /missing key "gone" \(resolving a -> b -> gone\)/);
    });
    (0, node_test_1.test)("getting an unknown top-level key throws", () => {
        const cfg = new config_1.ConfigStore();
        strict_1.default.throws(() => cfg.get("nope"), config_1.MissingKeyError);
    });
});
(0, node_test_1.describe)("escaping", () => {
    (0, node_test_1.test)("\\${key} stays a literal placeholder", () => {
        const cfg = new config_1.ConfigStore({ a: "REAL", b: "\\${a}" });
        strict_1.default.equal(cfg.get("b"), "${a}");
    });
    (0, node_test_1.test)("escaped placeholder is not re-expanded", () => {
        const cfg = new config_1.ConfigStore({ a: "${b}", b: "loop", c: "\\${a}" });
        strict_1.default.equal(cfg.get("c"), "${a}");
    });
    (0, node_test_1.test)("backslash before a non-$ char is kept literally", () => {
        const cfg = new config_1.ConfigStore({ a: "C:\\temp\\file" });
        strict_1.default.equal(cfg.get("a"), "C:\\temp\\file");
    });
    (0, node_test_1.test)("backslash directly before a placeholder escapes it even in paths", () => {
        const cfg = new config_1.ConfigStore({ a: "C:\\temp\\${missing}" });
        strict_1.default.equal(cfg.get("a"), "C:\\temp${missing}");
    });
    (0, node_test_1.test)("unterminated placeholder is an error", () => {
        const cfg = new config_1.ConfigStore({ a: "open ${oops" });
        strict_1.default.throws(() => cfg.get("a"), config_1.UnterminatedPlaceholderError);
    });
});
(0, node_test_1.describe)("cycle detection", () => {
    (0, node_test_1.test)("direct self reference reports path from the requested key", () => {
        const cfg = new config_1.ConfigStore({ a: "${a}" });
        strict_1.default.throws(() => cfg.get("a"), (err) => err instanceof config_1.CycleError && err.message === "circular reference: a -> a");
    });
    (0, node_test_1.test)("indirect cycle path starts at the requested key", () => {
        const cfg = new config_1.ConfigStore({ a: "${b}", b: "${c}", c: "${a}" });
        try {
            cfg.get("a");
            strict_1.default.ok(false, "expected CycleError");
        }
        catch (err) {
            strict_1.default.ok(err instanceof config_1.CycleError);
            strict_1.default.deepEqual(err.path, ["a", "b", "c", "a"]);
            strict_1.default.equal(err.message, "circular reference: a -> b -> c -> a");
        }
    });
    (0, node_test_1.test)("cycle not containing the requested key still reports full path from it", () => {
        const cfg = new config_1.ConfigStore({ a: "prefix-${b}", b: "${c}", c: "${b}" });
        strict_1.default.throws(() => cfg.get("a"), (err) => err instanceof config_1.CycleError && err.message === "circular reference: a -> b -> c -> b");
    });
});
(0, node_test_1.describe)("versioned dependency cache", () => {
    (0, node_test_1.test)("results are cached and recomputed only after a dependency changes", () => {
        const cfg = new config_1.ConfigStore({ a: "1", b: "${a}", c: "${b}", d: "static" });
        strict_1.default.equal(cfg.get("c"), "1");
        strict_1.default.equal(cfg.get("d"), "static");
        strict_1.default.equal(cfg.computeCounts.get("c"), 1);
        strict_1.default.equal(cfg.computeCounts.get("d"), 1);
        cfg.get("c");
        cfg.get("d");
        strict_1.default.equal(cfg.computeCounts.get("c"), 1, "c served from cache");
        strict_1.default.equal(cfg.computeCounts.get("d"), 1, "d served from cache");
    });
    (0, node_test_1.test)("modifying a key invalidates only its dependents", () => {
        const cfg = new config_1.ConfigStore({ a: "1", b: "${a}!", c: "${b}!", d: "solo", e: "${d}!" });
        for (const key of ["a", "b", "c", "d", "e"])
            cfg.get(key);
        cfg.set("a", "2");
        cfg.get("c");
        cfg.get("e");
        strict_1.default.equal(cfg.get("c"), "2!!");
        strict_1.default.equal(cfg.computeCounts.get("b"), 2, "b depends on a");
        strict_1.default.equal(cfg.computeCounts.get("c"), 2, "c depends on a transitively");
        strict_1.default.equal(cfg.computeCounts.get("d"), 1, "d untouched");
        strict_1.default.equal(cfg.computeCounts.get("e"), 1, "e does not depend on a");
    });
    (0, node_test_1.test)("deleting a key invalidates dependents and surfaces MissingKeyError", () => {
        const cfg = new config_1.ConfigStore({ a: "1", b: "${a}" });
        strict_1.default.equal(cfg.get("b"), "1");
        cfg.delete("a");
        strict_1.default.throws(() => cfg.get("b"), (err) => err instanceof config_1.MissingKeyError);
    });
    (0, node_test_1.test)("cached resolution always matches uncached resolution across mutations", () => {
        const cfg = new config_1.ConfigStore({
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
                strict_1.default.equal(cfg.get(key), cfg.resolveUncached(key), `mismatch on ${key}`);
            }
        };
        checkAll();
        cfg.set("host", "internal.lan");
        checkAll();
        strict_1.default.equal(cfg.get("health"), "http://internal.lan:8080/v1/health");
        cfg.set("port", "9090");
        checkAll();
        cfg.set("base", "https://${host}");
        checkAll();
        strict_1.default.equal(cfg.get("api"), "https://internal.lan/v1");
        cfg.set("host", "again.example");
        checkAll();
        strict_1.default.equal(cfg.get("health"), "https://again.example/v1/health");
    });
    (0, node_test_1.test)("cached and uncached agree on errors too", () => {
        const cfg = new config_1.ConfigStore({ a: "${b}", b: "${a}", c: "${missing}" });
        for (const key of ["a", "c"]) {
            let cachedErr;
            let uncachedErr;
            try {
                cfg.get(key);
            }
            catch (err) {
                cachedErr = err;
            }
            try {
                cfg.resolveUncached(key);
            }
            catch (err) {
                uncachedErr = err;
            }
            strict_1.default.equal(cachedErr.constructor, uncachedErr.constructor);
            strict_1.default.equal(cachedErr.message, uncachedErr.message);
        }
    });
});
