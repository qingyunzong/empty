import test from "node:test";
import assert from "node:assert";
import { runCli } from "../src/app";

test("SAT exits 0 and prints minimal step intervals", () => {
  const r = runCli([], "var x in [0, 100]\nx % 7 == 3\nx != 10\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\{3\}/);
  assert.match(r.out, /\[17 .. 94\] step 7/);
  assert.match(r.out, /verification \[exhaustive\]: OK/);
  assert.match(r.out, /status: SAT/);
});

test("UNSAT exits 1 and prints a certificate", () => {
  const r = runCli([], "var x in [0, 10]\nx >= 5\nx <= 3\n");
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /certificate: empty interval/);
  assert.match(r.out, /status: UNSAT/);
});

test("--json emits parseable output with stringified bigints", () => {
  const r = runCli(["--json"], "var x in [0, 20]\n3*x % 12 == 6\n");
  assert.equal(r.code, 0, r.err);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.status, "sat");
  assert.deepStrictEqual(parsed.variables[0].intervals, [{ start: "2", end: "18", step: "4" }]);
  assert.equal(parsed.verification[0].mode, "exhaustive");
});

test("strict bounds are exact in CLI output (no float rounding)", () => {
  const r = runCli([], `var x in [0, ${2n ** 62n}]\n8*x + 3 <= 9223372036854775799\n`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1152921504606846974/);
  assert.doesNotMatch(r.out, /1152921504606846976/);
});

test("parse errors exit 2 with a message on stderr", () => {
  const r = runCli([], "var x in [0, 10]\nx + <= 3\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /error:/);
});

test("huge domains fall back to boundary verification", () => {
  const r = runCli(
    ["--verify-limit", "100"],
    `var x in [${-(2n ** 63n)}, ${2n ** 63n - 1n}]\nx % 2 == 1\n`
  );
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /verification \[boundary\]: OK/);
});

test("--no-verify skips verification output", () => {
  const r = runCli(["--no-verify"], "var x in [0, 5]\n");
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /verification/);
});
