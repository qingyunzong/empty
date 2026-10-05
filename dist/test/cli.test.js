import { test, describe } from "node:test";
import { equal, match, ok, deepEqual } from "node:assert/strict";
import { run } from "../src/cli.js";
const FIXTURE = "fixtures/sample.json";
function runCli(args) {
    let stdout = "";
    let stderr = "";
    const code = run(args, {
        out: (chunk) => {
            stdout += chunk;
        },
        err: (chunk) => {
            stderr += chunk;
        },
    });
    return { code, stdout, stderr };
}
describe("cli", () => {
    test("prints the winning path and exits 0", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf", "--usage", "serverAuth"]);
        equal(r.code, 0);
        match(r.stdout, /OK path \(3 certificates\): leaf -> ca-a -> root-z/);
    });
    test("emits machine-readable JSON with --json", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf", "--usage", "serverAuth", "--json"]);
        equal(r.code, 0);
        deepEqual(JSON.parse(r.stdout), { ok: true, path: ["leaf", "ca-a", "root-z"] });
    });
    test("clientAuth is only served by the ca-a chain", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf", "--usage", "clientAuth"]);
        equal(r.code, 0);
        match(r.stdout, /leaf -> ca-a -> root-z/);
    });
    test("a trusted root alone is a valid 1-certificate path", () => {
        const r = runCli([FIXTURE, "--leaf", "root-a", "--usage", "serverAuth"]);
        equal(r.code, 0);
        match(r.stdout, /OK path \(1 certificates\): root-a/);
    });
    test("reports a failure reason and exits 1 when no path exists", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf", "--usage", "emailProtection"]);
        equal(r.code, 1);
        match(r.stdout, /FAIL \[LEAF_USAGE_MISMATCH\]/);
    });
    test("failure JSON includes the structured reason", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf", "--usage", "emailProtection", "--json"]);
        equal(r.code, 1);
        const payload = JSON.parse(r.stdout);
        equal(payload.ok, false);
        equal(payload.failure.code, "LEAF_USAGE_MISMATCH");
        equal(payload.failure.certId, "leaf");
    });
    test("exits 2 on missing arguments", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf"]);
        equal(r.code, 2);
        match(r.stderr, /missing required arguments/);
    });
    test("exits 2 on an unreadable input file", () => {
        const r = runCli(["fixtures/does-not-exist.json", "--leaf", "leaf", "--usage", "serverAuth"]);
        equal(r.code, 2);
        match(r.stderr, /cannot read input file/);
    });
    test("exits 2 on malformed JSON input", () => {
        const r = runCli(["package.json", "--leaf", "leaf", "--usage", "serverAuth"]);
        equal(r.code, 2);
        match(r.stderr, /invalid input: "certificates" must be an array/);
    });
    test("exits 2 on a non-integer max length", () => {
        const r = runCli([FIXTURE, "--leaf", "leaf", "--usage", "serverAuth", "--max-length", "abc"]);
        equal(r.code, 2);
        match(r.stderr, /--max-length must be a positive integer/);
    });
    test("--help prints usage and exits 0", () => {
        const r = runCli(["--help"]);
        equal(r.code, 0);
        ok(r.stdout.includes("Usage: certpath"));
    });
});
