import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/interpreter.js";
import { InterpreterError } from "../src/events.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), "weld-cli-"));
  const input = path.join(dir, "mode-events.jsonl");
  writeFileSync(input, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const outDir = path.join(dir, "out");
  const proc = spawnSync(process.execPath, [CLI, "run", input, "--out-dir", outDir], { encoding: "utf8" });
  return { proc, outDir };
}

const unknownMode = [{ seq: 1, clock: 0, source: "hmi", type: "mode_request", mode: "party" }];
const nonMonotonic = [
  { seq: 1, clock: 3, source: "plc", type: "door", state: "open" },
  { seq: 2, clock: 2, source: "plc", type: "door", state: "closed" },
];
const doorContradiction = [
  { seq: 1, clock: 4, source: "plc", type: "door", state: "open" },
  { seq: 2, clock: 4, source: "hmi", type: "door", state: "closed" },
];

test("库: 未知模式抛 exitCode 13", () => {
  assert.throws(() => run(unknownMode), (err) => err instanceof InterpreterError && err.exitCode === 13);
});

test("库: 时钟非单调抛 exitCode 14", () => {
  assert.throws(() => run(nonMonotonic), (err) => err.exitCode === 14);
});

test("库: 门磁状态矛盾抛 exitCode 15", () => {
  assert.throws(() => run(doorContradiction), (err) => err.exitCode === 15);
});

test("CLI: 未知模式 exit 13", () => {
  const { proc } = runCli(unknownMode);
  assert.equal(proc.status, 13);
});

test("CLI: 时钟非单调 exit 14", () => {
  const { proc } = runCli(nonMonotonic);
  assert.equal(proc.status, 14);
});

test("CLI: 门磁矛盾 exit 15", () => {
  const { proc } = runCli(doorContradiction);
  assert.equal(proc.status, 15);
});

test("CLI: 正常流程写出 transition.jsonl 与 violations.jsonl", () => {
  const { proc, outDir } = runCli([
    { seq: 1, clock: 0, source: "hmi", type: "mode_request", mode: "teach" },
    { seq: 2, clock: 1, source: "hmi", type: "speed_request", value: 600 },
  ]);
  assert.equal(proc.status, 0, proc.stderr);
  const transitions = readFileSync(path.join(outDir, "transition.jsonl"), "utf8").trim().split("\n");
  const violations = readFileSync(path.join(outDir, "violations.jsonl"), "utf8").trim().split("\n");
  assert.equal(transitions.length, 2);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /rule_conflict/);
  assert.ok(existsSync(path.join(outDir, "transition.jsonl")));
});

test("CLI: 缺参数 exit 2", () => {
  const proc = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(proc.status, 2);
});
