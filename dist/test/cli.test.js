import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/app.js";
test("cli: single step inversion", () => {
    const r = runCli(["4", "--steps", "1/2"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "[7, 9]\n");
});
test("cli: chained steps and verify flag", () => {
    const r = runCli(["72", "--steps", "9/10,4/5", "--verify"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^\[\d+, \d+\]\n$/);
    assert.match(r.stderr, /^verify ok \(\d+ forward checks, exhaustive\)\n$/);
});
test("cli: repeated --steps flags accumulate", () => {
    const a = runCli(["72", "--steps", "9/10,4/5"]);
    const b = runCli(["72", "--steps", "9/10", "--steps", "4/5"]);
    assert.equal(a.stdout, b.stdout);
});
test("cli: unreachable amount prints EMPTY", () => {
    const r = runCli(["3", "--steps", "2/1"]);
    assert.equal(r.stdout, "EMPTY\n");
});
test("cli: json output", () => {
    const r = runCli(["4", "--steps", "1/2", "--json"]);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.intervals, [["7", "9"]]);
    assert.equal(parsed.amount, "4");
    assert.deepEqual(parsed.steps, ["1/2"]);
});
test("cli: custom cap clamps the interval", () => {
    const r = runCli(["0", "--steps", "1/100", "--cap", "10"]);
    assert.equal(r.stdout, "[0, 10]\n");
});
test("cli: rejects more than 8 steps", () => {
    const r = runCli(["1", "--steps", Array.from({ length: 9 }, () => "1/2").join(",")]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /at most 8 steps/);
});
test("cli: rejects missing amount and bad step syntax", () => {
    assert.equal(runCli(["--steps", "1/2"]).code, 2);
    assert.equal(runCli(["4", "--steps", "x/y"]).code, 2);
    assert.equal(runCli(["4", "--steps", "0/5"]).code, 2);
    assert.equal(runCli(["-3", "--steps", "1/2"]).code, 2);
});
test("cli: help exits 0", () => {
    const r = runCli(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: quote/);
});
