import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";

interface Capture {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const proc = process as unknown as {
    stdout: { write(chunk: string): void };
    stderr: { write(chunk: string): void };
  };
  const origOut = proc.stdout.write;
  const origErr = proc.stderr.write;
  proc.stdout.write = (chunk: string) => {
    out.push(chunk);
  };
  proc.stderr.write = (chunk: string) => {
    err.push(chunk);
  };
  try {
    const status = run(["node", "path-cli", ...args]);
    return { status, stdout: out.join(""), stderr: err.join("") };
  } finally {
    proc.stdout.write = origOut;
    proc.stderr.write = origErr;
  }
}

function writeGraph(name: string, input: unknown): string {
  const file = join(tmpdir(), `path-cli-test-${name}.json`);
  writeFileSync(file, JSON.stringify(input));
  return file;
}

test("cli prints the witness and exits 0", () => {
  const file = writeGraph("ok", {
    edges: [
      { from: "s", to: "a", cost: 5 },
      { from: "a", to: "t", cost: 5 },
      { from: "s", to: "b", cost: 6 },
      { from: "b", to: "t", cost: 1 },
    ],
    start: "s",
    end: "t",
  });
  try {
    const { status, stdout } = runCli([file]);
    equal(status, 0);
    const w = JSON.parse(stdout);
    equal(w.found, true);
    deepEqual(w.path, ["s", "a", "t"]);
    equal(w.maxEdgeCost, 5);
    equal(w.totalCost, 10);
    equal(w.nodeCount, 3);
  } finally {
    unlinkSync(file);
  }
});

test("cli exits 1 when no feasible path exists", () => {
  const file = writeGraph("none", {
    edges: [{ from: "s", to: "a", cost: 1 }],
    start: "s",
    end: "t",
  });
  try {
    const { status, stdout } = runCli([file]);
    equal(status, 1);
    equal(JSON.parse(stdout).found, false);
  } finally {
    unlinkSync(file);
  }
});

test("cli exits 2 on missing file, bad json, invalid input, and bad usage", () => {
  equal(runCli([join(tmpdir(), "path-cli-does-not-exist.json")]).status, 2);
  const bad = join(tmpdir(), "path-cli-test-bad.json");
  writeFileSync(bad, "{ not json");
  const invalid = writeGraph("invalid", { edges: [], start: "s", end: "t", maxNodes: -1 });
  try {
    equal(runCli([bad]).status, 2);
    equal(runCli([invalid]).status, 2);
    equal(runCli([]).status, 2);
    const help = runCli(["--help"]);
    equal(help.status, 0);
    ok(help.stdout.includes("usage: path-cli"));
  } finally {
    unlinkSync(bad);
    unlinkSync(invalid);
  }
});
