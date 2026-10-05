import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
function run(args) {
    const out = [];
    const err = [];
    const code = runCli(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
}
test("CLI: solve emits a certificate that verify accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "bitplanner-"));
    const cert = join(dir, "cert.json");
    const r = run(["solve", "examples/lights.json", "--cert", cert]);
    assert.equal(r.code, 0);
    assert.match(r.out, /shortest plan \(4 steps\)/);
    const v = run(["verify", "examples/lights.json", cert]);
    assert.equal(v.code, 0);
    assert.match(v.out, /certificate OK/);
});
test("CLI: closure reports reachable states and histogram", () => {
    const r = run(["closure", "examples/robot.json"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /reachable states: \d+/);
    assert.match(r.out, /depth histogram:/);
});
test("CLI: learn finds a plan and records nogoods", () => {
    const r = run(["learn", "examples/lights.json"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /plan \(\d+ steps\)/);
    assert.match(r.out, /learned nogoods: \d+/);
});
test("CLI: bounds runs A* with zero lower-bound violations", () => {
    const r = run(["bounds", "examples/robot.json"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /A\* plan \(3 steps\)/);
    assert.match(r.out, /lower-bound violations: 0/);
});
test("CLI: pause then resume yields the optimal plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "bitplanner-"));
    const snap = join(dir, "snap.json");
    const paused = run(["solve", "examples/robot.json", "--pause-after", "2", "--snapshot", snap]);
    assert.equal(paused.code, 0);
    assert.match(paused.out, /paused after 2 expansions/);
    const resumed = run(["resume", "examples/robot.json", snap]);
    assert.equal(resumed.code, 0);
    assert.match(resumed.out, /plan \(3 steps\)/);
});
test("CLI: mutex problem is rejected with a clear error", () => {
    const r = run(["solve", "examples/mutex-bad.json"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /mutex rejected/);
});
test("CLI: verify rejects a corrupted certificate", () => {
    const dir = mkdtempSync(join(tmpdir(), "bitplanner-"));
    const cert = join(dir, "cert.json");
    run(["solve", "examples/lights.json", "--cert", cert]);
    const c = JSON.parse(readFileSync(cert, "utf8"));
    c.length = 2; // claim a shorter optimum
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify(c));
    const r = run(["verify", "examples/lights.json", bad]);
    assert.equal(r.code, 1);
});
