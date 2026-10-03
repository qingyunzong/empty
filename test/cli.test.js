import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, EXIT } from "../bin/repro.js";

function cli(args) {
  const r = run(args);
  return { code: r.code, json: r.stdout ? JSON.parse(r.stdout) : null };
}

function ok(args) {
  const r = cli(args);
  assert.equal(r.code, EXIT.OK, `expected exit 0, got ${r.code}: ${JSON.stringify(r.json)}`);
  return r.json;
}

const spec = {
  machines: 2,
  memoryLimit: 5,
  steps: [
    { id: "a", params: ["v0", "v1"], memory: 2, duration: 2 },
    { id: "b", params: ["v0", "v1"], memory: 2, duration: 1 },
  ],
  edges: [["a", "b"]],
  compat: { "a>b": { v0: ["v0", "v1"], v1: ["v1"] } },
};

test("CLI end-to-end: init, pin, run, fork, merge, unpin", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  const statePath = join(dir, "state.json");
  const certPath = join(dir, "cert.json");
  writeFileSync(specPath, JSON.stringify(spec));

  assert.equal(ok(["init", "--spec", specPath, "--state", statePath]).status, "OK");
  assert.equal(ok(["pin", "--state", statePath, "--step", "b", "--param", "v1"]).status, "OK");

  const runOut = ok(["run", "--state", statePath, "--cert", certPath]);
  assert.equal(runOut.status, "SAT");
  assert.equal(runOut.plan.b.param, "v1");

  const cert = JSON.parse(readFileSync(certPath, "utf8"));
  assert.equal(cert.format, "repro-cert/1");

  assert.equal(ok(["fork", "--state", statePath, "--name", "exp"]).status, "OK");
  assert.equal(ok(["merge", "--state", statePath, "--src", "main", "--dst", "exp"]).status, "OK");
  assert.equal(ok(["unpin", "--state", statePath, "--step", "b"]).status, "OK");
});

test("CLI solve + verify round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  const certPath = join(dir, "cert.json");
  writeFileSync(specPath, JSON.stringify(spec));

  const out = ok(["solve", "--spec", specPath, "--cert", certPath]);
  assert.equal(out.status, "SAT");
  assert.ok(out.makespan >= 3);

  assert.equal(ok(["verify", "--spec", specPath, "--cert", certPath]).status, "VERIFIED");
});

test("CLI insert-job extends the DAG", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  const statePath = join(dir, "state.json");
  writeFileSync(specPath, JSON.stringify(spec));
  ok(["init", "--spec", specPath, "--state", statePath]);
  const r = ok([
    "insert-job", "--state", statePath,
    "--job", JSON.stringify({ id: "c", params: ["v0"], memory: 1, duration: 1 }),
    "--edge", "b>c",
  ]);
  assert.deepEqual(r.steps, ["a", "b", "c"]);
  const runOut = ok(["run", "--state", statePath]);
  assert.equal(runOut.status, "SAT");
  assert.ok(runOut.plan.c.start >= runOut.plan.b.start + 1);
});

test("CLI reports UNSAT with exit code 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({ machines: 1, memoryLimit: 1, steps: [{ id: "a", params: ["v"], memory: 5 }], edges: [] }),
  );
  const r = cli(["solve", "--spec", specPath]);
  assert.equal(r.code, EXIT.UNSAT);
  assert.equal(r.json.status, "UNSAT");
});

test("CLI reports PENDING with exit code 4", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const r = cli(["solve", "--spec", specPath, "--max-nodes", "0"]);
  assert.equal(r.code, EXIT.PENDING);
  assert.equal(r.json.status, "PENDING");
});

test("CLI reports INVALID_INPUT with exit code 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "{not json");
  const r = cli(["solve", "--spec", badPath]);
  assert.equal(r.code, EXIT.INVALID_INPUT);
  assert.equal(r.json.status, "INVALID_INPUT");

  assert.equal(cli(["frobnicate"]).code, EXIT.INVALID_INPUT);
});

test("CLI merge reports CONFLICT with exit code 5 and the divergence edge", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  const statePath = join(dir, "state.json");
  writeFileSync(specPath, JSON.stringify(spec));
  ok(["init", "--spec", specPath, "--state", statePath]);
  ok(["pin", "--state", statePath, "--step", "a", "--param", "v0"]);
  ok(["fork", "--state", statePath, "--name", "exp"]);
  ok(["pin", "--state", statePath, "--step", "b", "--param", "v0", "--branch", "main"]);
  ok(["pin", "--state", statePath, "--step", "b", "--param", "v1", "--branch", "exp"]);
  const r = cli(["merge", "--state", statePath, "--src", "main", "--dst", "exp"]);
  assert.equal(r.code, EXIT.CONFLICT);
  assert.equal(r.json.status, "CONFLICT");
  assert.equal(r.json.divergence.index, 1);
  assert.equal(r.json.divergence.src.entry.step, "b");
});

test("CLI verify rejects a tampered certificate with exit code 6", () => {
  const dir = mkdtempSync(join(tmpdir(), "repro-"));
  const specPath = join(dir, "spec.json");
  const certPath = join(dir, "cert.json");
  writeFileSync(specPath, JSON.stringify(spec));
  ok(["solve", "--spec", specPath, "--cert", certPath]);
  const cert = JSON.parse(readFileSync(certPath, "utf8"));
  cert.result.makespan = 999;
  writeFileSync(certPath, JSON.stringify(cert));
  const r = cli(["verify", "--spec", specPath, "--cert", certPath]);
  assert.equal(r.code, EXIT.INVALID);
  assert.equal(r.json.status, "INVALID");
});
