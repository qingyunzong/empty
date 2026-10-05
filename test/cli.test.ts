import { test } from "node:test";
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "src", "cli.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Note: in this environment a nested node process cannot inherit a piped
// stdout, so the CLI is run through sh with output redirected to files.
function run(args: string[]): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "clog-run-"));
  const outFile = join(dir, "out");
  const errFile = join(dir, "err");
  const codeFile = join(dir, "code");
  const cmd = [process.execPath, CLI, ...args].map(shellQuote).join(" ");
  spawnSync(
    "/bin/sh",
    ["-c", `${cmd} > ${shellQuote(outFile)} 2> ${shellQuote(errFile)}; printf %s $? > ${shellQuote(codeFile)}`],
    { encoding: "utf8" }
  );
  return {
    status: Number(readFileSync(codeFile, "utf8")),
    stdout: readFileSync(outFile, "utf8"),
    stderr: readFileSync(errFile, "utf8"),
  };
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("cli end-to-end: order, snapshot, publish, revise accept/reject", () => {
  const dir = mkdtempSync(join(tmpdir(), "clog-"));
  const log = join(dir, "log.jsonl");
  writeJsonl(log, [
    { id: "a1", source: "A", seq: 1, ts: 30, deps: ["b1"] },
    { id: "b1", source: "B", seq: 1, ts: 10, deps: [] },
    { id: "a2", source: "A", seq: 2, ts: 20, deps: [] },
  ]);

  // 1. Full order with automatic small-graph enumeration cross-check.
  const orderRun = run(["order", log]);
  assert.strictEqual(orderRun.status, 0, orderRun.stderr);
  const orderOut = JSON.parse(orderRun.stdout);
  assert.deepStrictEqual(orderOut.order, ["b1", "a2", "a1"]);
  assert.strictEqual(orderOut.enumeration.count, 3);
  assert.strictEqual(orderOut.enumeration.matchesLexMin, true);

  // 2. Save a snapshot, publish the first event.
  const snap0 = join(dir, "snap0.json");
  assert.strictEqual(run(["order", log, "--snapshot", snap0]).status, 0);
  assert.ok(existsSync(snap0));

  const snap1 = join(dir, "snap1.json");
  const pubRun = run(["publish", snap0, "1", "--out", snap1]);
  assert.strictEqual(pubRun.status, 0, pubRun.stderr);
  assert.deepStrictEqual(JSON.parse(pubRun.stdout).published, ["b1"]);

  // 3. Accepted revision: new event c1 depending on a1.
  const batchOk = join(dir, "batch-ok.jsonl");
  writeJsonl(batchOk, [{ id: "c1", source: "C", seq: 1, ts: 5, deps: ["a1"] }]);
  const snap2 = join(dir, "snap2.json");
  const okRun = run(["revise", snap1, batchOk, "--out", snap2]);
  assert.strictEqual(okRun.status, 0, okRun.stderr);
  const okOut = JSON.parse(okRun.stdout);
  assert.strictEqual(okOut.rejected, false);
  assert.deepStrictEqual(okOut.order, ["b1", "a2", "a1", "c1"]);

  // 4. Rejected revision: published b1 would have to follow unpublished c1.
  const batchBad = join(dir, "batch-bad.jsonl");
  writeJsonl(batchBad, [{ addDep: { id: "b1", dep: "c1" } }]);
  const snap3 = join(dir, "snap3.json");
  const badRun = run(["revise", snap2, batchBad, "--out", snap3]);
  assert.strictEqual(badRun.status, 2, badRun.stdout);
  const badOut = JSON.parse(badRun.stdout);
  assert.strictEqual(badOut.rejected, true);
  assert.deepStrictEqual(badOut.conflicts[0].chain, ["c1", "b1"]);
  assert.ok(!existsSync(snap3), "rejected batch must not write a snapshot");

  // 5. show still works on the last good snapshot.
  const showRun = run(["show", snap2]);
  assert.strictEqual(showRun.status, 0, showRun.stderr);
  assert.deepStrictEqual(JSON.parse(showRun.stdout).order, ["b1", "a2", "a1", "c1"]);
});

test("cli order reports missing dependencies and cycles with evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "clog-"));
  const log = join(dir, "log.jsonl");
  writeJsonl(log, [
    { id: "w1", source: "A", seq: 1, ts: 1, deps: ["ghost"] },
    { id: "w2", source: "A", seq: 2, ts: 2, deps: ["w1"] },
    { id: "x", source: "B", seq: 1, ts: 3, deps: ["z"] },
    { id: "y", source: "B", seq: 2, ts: 4, deps: ["x"] },
    { id: "z", source: "B", seq: 3, ts: 5, deps: ["y"] },
    { id: "ok", source: "C", seq: 1, ts: 6, deps: [] },
  ]);
  const r = run(["order", log]);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.order, ["ok"]);
  assert.deepStrictEqual(out.diagnostics.missing, { ghost: ["w1"] });
  assert.deepStrictEqual(out.diagnostics.withheld, { w1: ["ghost"], w2: ["ghost"] });
  assert.strictEqual(out.diagnostics.cycles.length, 1);
  assert.deepStrictEqual([...out.diagnostics.cycles[0]].sort(), ["x", "y", "z"]);
});

test("cli rejects malformed input with exit code 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "clog-"));
  const log = join(dir, "bad.jsonl");
  writeFileSync(log, '{"id":"a","source":"A","seq":"oops","ts":1,"deps":[]}\n');
  const r = run(["order", log]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /seq/);
});
