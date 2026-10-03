"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "labsched.js");

// Spawn the CLI through bash with output redirected to files: this sandbox
// denies node->node spawn (EPERM) and loses piped stdout, so we capture via
// temp files and read the real exit code from a file.
let tmpCount = 0;
function runCli(lines, extraArgs = []) {
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
  return { status, stdout, stderr };
}

test("volume exceeding the plate exits 5 with VOLUME_EXCEEDS_PLATE", () => {
  const r = runCli([
    JSON.stringify({
      op: "enqueue",
      task: { id: "t1", project: "P1", volume: 5000, priority: 1, segments: [{ temp: 20, duration: 5 }] },
    }),
  ]);
  assert.equal(r.status, 5);
  const out = JSON.parse(r.stdout);
  assert.equal(out.error.code, "VOLUME_EXCEEDS_PLATE");
});

test("negative budget exits 5 with BUDGET_NEGATIVE", () => {
  const r = runCli([JSON.stringify({ op: "budget", project: "P1", set: -10 })]);
  assert.equal(r.status, 5);
  assert.equal(JSON.parse(r.stdout).error.code, "BUDGET_NEGATIVE");
});

test("temperature jump beyond maxTempDelta exits 5 with COOLDOWN_CONFLICT", () => {
  const r = runCli([
    JSON.stringify({
      op: "enqueue",
      task: {
        id: "t1",
        project: "P1",
        volume: 10,
        priority: 1,
        segments: [
          { temp: 20, duration: 5 },
          { temp: 100, duration: 5 },
        ],
      },
    }),
  ]);
  assert.equal(r.status, 5);
  assert.equal(JSON.parse(r.stdout).error.code, "COOLDOWN_CONFLICT");
});

test("clean run exits 0 and reports timelines, failures and log root", () => {
  const r = runCli([
    JSON.stringify({ op: "budget", project: "P1", set: 100 }),
    JSON.stringify({
      op: "enqueue",
      task: { id: "t1", project: "P1", volume: 30, priority: 1, segments: [{ temp: 20, duration: 5 }] },
    }),
    "not json at all",
  ]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.makespan, 10); // 5 cooldown (25->20) + 5 run
  assert.equal(out.channels.length, 2);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].code, "INVALID_JSON");
  assert.match(out.logRoot, /^[0-9a-f]{64}$/);
});
