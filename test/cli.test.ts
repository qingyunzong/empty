import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";

test("common intersection prints a witness and exits 0", () => {
  const res = runCli(["a/*", "*/b"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /status: common/);
  assert.match(res.stdout, /witness: a\/b/);
});

test("disjoint intersection exits 1", () => {
  const res = runCli(["a", "b"]);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stdout, /status: disjoint/);
});

test("tiny budget reports unknown and exits 2", () => {
  const res = runCli(["a/**", "**/b", "--budget", "1"]);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stdout, /status: unknown/);
});

test("excludes and verification", () => {
  const res = runCli(["a/**", "**/b", "--exclude", "a/b", "--verify", "--json"]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout) as {
    status: string;
    witness: string[];
    verified: string;
  };
  assert.equal(out.status, "common");
  assert.deepEqual(out.witness, ["a", "a", "b"]);
  assert.match(out.verified, /^yes/);
});

test("usage errors exit 64", () => {
  assert.equal(runCli(["a//b", "c"]).code, 64);
  assert.equal(runCli(["a"]).code, 64);
  assert.equal(runCli(["a", "b", "--exclude"]).code, 64);
  const many = ["a", "b"];
  for (let k = 0; k < 11; k++) many.push("--exclude", "x");
  assert.equal(runCli(many).code, 64);
});

test("help prints usage", () => {
  const res = runCli(["--help"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /usage:/);
});
