import assert from "node:assert/strict";
import { test } from "node:test";
import { run, type CliIO } from "../src/cli.js";

function makeIo(stdin = "") {
  const io: CliIO & { stdout: string; stderr: string } = {
    stdout: "",
    stderr: "",
    out(chunk: string) {
      this.stdout += chunk;
    },
    err(chunk: string) {
      this.stderr += chunk;
    },
    readStdin: () => stdin,
  };
  return io;
}

test("differ example: exit 0, minimal witness, cross-check passed", () => {
  const io = makeIo();
  const status = run(["examples/differ.json"], io);
  assert.equal(status, 0, io.stderr);
  assert.ok(io.stdout.includes("verdict: DIFFER"));
  assert.ok(io.stdout.includes('witness: { role: "admin", mfa: false }  (2 specified fields)'));
  assert.ok(io.stdout.includes("baseline: permit"));
  assert.ok(io.stdout.includes("hardened: deny"));
  assert.ok(io.stdout.includes("checked: 6 of 9"));
  assert.ok(io.stdout.includes("cross-check: passed"));
});

test("equivalent example: exit 1 with exhaustive conclusion", () => {
  const io = makeIo();
  const status = run(["examples/equivalent.json"], io);
  assert.equal(status, 1, io.stderr);
  assert.ok(io.stdout.includes("verdict: EQUIVALENT"));
  assert.ok(io.stdout.includes("checked: 9 of 9"));
});

test("undecided example: exit 2 when the budget runs out", () => {
  const io = makeIo();
  const status = run(["examples/undecided.json"], io);
  assert.equal(status, 2, io.stderr);
  assert.ok(io.stdout.includes("verdict: UNDECIDED"));
  assert.ok(io.stdout.includes("checked: 10 of 256"));
});

test("--json emits a machine-readable report", () => {
  const io = makeIo();
  const status = run(["examples/differ.json", "--json"], io);
  assert.equal(status, 0, io.stderr);
  const report = JSON.parse(io.stdout);
  assert.equal(report.verdict, "DIFFER");
  assert.deepEqual(report.witness, { role: "admin", mfa: false });
  assert.equal(report.specifiedFields, 2);
  assert.deepEqual(report.decisions, { baseline: "permit", hardened: "deny" });
  assert.equal(report.checked, 6);
  assert.equal(report.space, "9");
  assert.equal(report.crossCheck.status, "passed");
});

test("reads the spec from stdin with '-'", () => {
  const spec = JSON.stringify({
    attributes: [{ name: "x", domain: [0, 1] }],
    policies: { a: {}, b: {} },
  });
  const io = makeIo(spec);
  const status = run(["-"], io);
  assert.equal(status, 1, io.stderr);
  assert.ok(io.stdout.includes("verdict: EQUIVALENT"));
});

test("--budget overrides the spec budget", () => {
  const io = makeIo();
  const status = run(["examples/differ.json", "--budget", "2"], io);
  assert.equal(status, 2, io.stderr);
  assert.ok(io.stdout.includes("verdict: UNDECIDED"));
});

test("invalid spec exits 3 with a clear message", () => {
  const spec = JSON.stringify({
    attributes: [{ name: "x", domain: [0, 1] }],
    policies: {
      a: { rules: Array.from({ length: 21 }, () => ({ effect: "deny" })) },
      b: {},
    },
  });
  const io = makeIo(spec);
  const status = run(["-"], io);
  assert.equal(status, 3);
  assert.ok(io.stderr.includes("too many rules: 21"));
});

test("missing file exits 3", () => {
  const io = makeIo();
  const status = run(["examples/nope.json"], io);
  assert.equal(status, 3);
});

test("--no-verify skips the cross-check", () => {
  const io = makeIo();
  const status = run(["examples/differ.json", "--no-verify"], io);
  assert.equal(status, 0, io.stderr);
  assert.ok(io.stdout.includes("cross-check: skipped"));
});

test("--help prints usage", () => {
  const io = makeIo();
  const status = run(["--help"], io);
  assert.equal(status, 0);
  assert.ok(io.stdout.includes("Usage: perm-diff"));
});
