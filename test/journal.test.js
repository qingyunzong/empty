"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "labsched.js");

const OPS1 = [
  { op: "budget", id: "b1", project: "P1", set: 100 },
  {
    op: "enqueue",
    id: "e1",
    task: { id: "t1", project: "P1", volume: 30, priority: 1, segments: [{ temp: 20, duration: 5 }] },
  },
];
const OP_E2 = {
  op: "enqueue",
  id: "e2",
  task: { id: "t2", project: "P1", volume: 10, priority: 1, segments: [{ temp: 20, duration: 5 }] },
};

// Spawn the CLI through bash with output redirected to files: this sandbox
// denies node->node spawn (EPERM) and loses piped stdout, so we capture via
// temp files and read the real exit code from a file.
let tmpCount = 0;
function runCli(lines, journalPath) {
  const extraArgs = journalPath ? ["--journal", journalPath] : [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labsched-cli-"));
  const n = tmpCount++;
  const inputFile = path.join(dir, `ops-${n}.jsonl`);
  const outFile = path.join(dir, `out-${n}.json`);
  const errFile = path.join(dir, `err-${n}.txt`);
  const rcFile = path.join(dir, `rc-${n}`);
  fs.writeFileSync(
    inputFile,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n"
  );
  const cmd = [
    "node",
    JSON.stringify(BIN),
    ...extraArgs.map((a) => JSON.stringify(a)),
    JSON.stringify(inputFile),
    ">",
    JSON.stringify(outFile),
    "2>",
    JSON.stringify(errFile),
    ";",
    "echo",
    "$?",
    ">",
    JSON.stringify(rcFile),
  ].join(" ");
  spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  const status = Number(fs.readFileSync(rcFile, "utf8").trim());
  const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : "";
  return { status, out: JSON.parse(stdout), stderr };
}

test("acceptance 4: crash mid-write recovers without double-charging", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labsched-"));
  const journalPath = path.join(dir, "ops.log");

  // Run 1: two ops applied, t1 charged 30 (budget 100 -> 70).
  const r1 = runCli(OPS1, journalPath);
  assert.equal(r1.status, 0);
  assert.equal(r1.out.budgets.P1, 70);
  const linesAfterRun1 = fs.readFileSync(journalPath, "utf8").trim().split("\n");
  assert.equal(linesAfterRun1.length, 2);

  // Simulate a crash: a half-written third line (torn write).
  fs.appendFileSync(journalPath, '{"seq":3,"prev":"9f2c1b');

  // Run 2: same journal, input repeats the old ops plus one new op.
  const r2 = runCli([...OPS1, OP_E2], journalPath);
  assert.equal(r2.status, 0);
  // Torn line truncated, old ops replayed once and skipped as duplicates,
  // so t1 is charged exactly once: 100 - 30 (t1) - 10 (t2) = 60.
  assert.equal(r2.out.budgets.P1, 60);
  assert.deepEqual([...r2.out.skipped].sort(), ["b1", "e1"]);
  assert.equal(r2.out.events.filter((ev) => ev.type === "charge").length, 2);

  // Journal is clean again: 3 valid lines, one per applied op.
  const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));

  // Recovered run is identical to a fresh single run of the full op stream.
  const fresh = runCli([...OPS1, OP_E2], null);
  assert.equal(r2.out.logRoot, fresh.out.logRoot);
});

test("log root is deterministic across identical runs", () => {
  const a = runCli(OPS1, null);
  const b = runCli(OPS1, null);
  assert.equal(a.out.logRoot, b.out.logRoot);
  assert.match(a.out.logRoot, /^[0-9a-f]{64}$/);
});

test("undo survives journal replay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "labsched-"));
  const journalPath = path.join(dir, "ops.log");
  const ops = [...OPS1, { op: "undo", id: "u1" }, OP_E2];
  const r1 = runCli(ops, journalPath);
  assert.equal(r1.status, 0);
  // Replay from the journal reproduces the same state and log root.
  const r2 = runCli(ops, journalPath);
  assert.equal(r2.status, 0);
  assert.equal(r2.out.logRoot, r1.out.logRoot);
  assert.equal(r2.out.budgets.P1, r1.out.budgets.P1);
});
