import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const CLI = resolve("dist/src/cli.js");
const FSM = resolve("examples/fsm.json");
const EVENTS = resolve("examples/events.json");

function runCli(args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
}

function readTrace(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("CLI minimizes the example and writes a complete judgment trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsm-min-"));
  const tracePath = join(dir, "trace.jsonl");
  const r = runCli(["--fsm", FSM, "--events", EVENTS, "--trace", tracePath]);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('["open","lock","write"]'));

  const entries = readTrace(tracePath);
  assert.equal(entries[0]?.type, "config");
  assert.ok(entries.some((e) => e.type === "test"));
  assert.ok(entries.some((e) => e.type === "verify"));

  const result = entries[entries.length - 1];
  assert.equal(result?.type, "result");
  assert.equal(result?.oneMinimal, true);
  assert.deepEqual(result?.minimized, ["open", "lock", "write"]);

  // every recorded verify entry confirms single deletions do not fail
  for (const e of entries.filter((x) => x.type === "verify")) {
    assert.ok(e.verdict !== "fail");
  }
});

test("CLI runs are reproducible: identical inputs give identical traces", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsm-min-"));
  const t1 = join(dir, "t1.jsonl");
  const t2 = join(dir, "t2.jsonl");
  assert.equal(runCli(["--fsm", FSM, "--events", EVENTS, "--trace", t1]).status, 0);
  assert.equal(runCli(["--fsm", FSM, "--events", EVENTS, "--trace", t2]).status, 0);
  assert.equal(readFileSync(t1, "utf8"), readFileSync(t2, "utf8"));
});

test("CLI rejects a history that does not fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsm-min-"));
  const events = join(dir, "pass.json");
  writeFileSync(events, JSON.stringify(["open", "close"]));
  const r = runCli(["--fsm", FSM, "--events", events, "--trace", join(dir, "t.jsonl")]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("does not reach a failure state"));
});

test("CLI rejects an illegal history instead of treating it as a failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsm-min-"));
  const events = join(dir, "illegal.json");
  writeFileSync(events, JSON.stringify(["write", "write"]));
  const r = runCli(["--fsm", FSM, "--events", events, "--trace", join(dir, "t.jsonl")]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("illegal"));
});

test("CLI exits 1 on missing arguments", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("--fsm"));
});
