import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const CLI = "dist/src/cli.js";

let counter = 0;

function runCli(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const id = `${process.pid}-${counter++}`;
  const outPath = `/tmp/policy-diff-test-${id}.out`;
  const errPath = `/tmp/policy-diff-test-${id}.err`;
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  let stdinFd: number | "ignore" = "ignore";
  if (input !== undefined) {
    const inPath = `/tmp/policy-diff-test-${id}.in`;
    writeFileSync(inPath, input);
    stdinFd = openSync(inPath, "r");
  }
  const result = spawnSync("node", [CLI, ...args], { stdio: [stdinFd, outFd, errFd] });
  if (stdinFd !== "ignore") closeSync(stdinFd);
  closeSync(outFd);
  closeSync(errFd);
  return {
    code: result.status ?? -1,
    stdout: readFileSync(outPath, "utf8"),
    stderr: readFileSync(errPath, "utf8"),
  };
}

function extractJson(stdout: string): { verdict: string; witness: { assignment: Record<string, string> } | null } {
  const start = stdout.indexOf("{");
  return JSON.parse(stdout.slice(start));
}

test("CLI: 差异示例输出最小见证", () => {
  const { code, stdout } = runCli(["examples/diff.json"]);
  assert.equal(code, 0);
  const result = extractJson(stdout);
  assert.equal(result.verdict, "DIFFERENT");
  assert.deepEqual(result.witness!.assignment, { mfa: "off", role: "admin" });
  assert.match(stdout, /DIFFERENT/);
});

test("CLI: 等价示例输出穷尽结论", () => {
  const { code, stdout } = runCli(["examples/equivalent.json"]);
  assert.equal(code, 0);
  assert.equal(extractJson(stdout).verdict, "EQUIVALENT");
  assert.match(stdout, /穷尽/);
});

test("CLI: 预算不足示例输出未决并以退出码 3 结束", () => {
  const { code, stdout } = runCli(["examples/undecided.json"]);
  assert.equal(code, 3);
  assert.equal(extractJson(stdout).verdict, "UNDECIDED");
  assert.match(stdout, /UNDECIDED/);
});

test("CLI: 标准输入读取与 --budget 覆盖", () => {
  const input = JSON.stringify({
    attributes: { a: ["0", "1"] },
    policies: {
      A: { default: "Y", rules: [{ when: { a: "1" }, decision: "X" }] },
      B: { default: "Y", rules: [] },
    },
  });
  const { code, stdout } = runCli(["-", "--budget", "1"], input);
  assert.equal(code, 3);
  assert.equal(extractJson(stdout).verdict, "UNDECIDED");
});

test("CLI: 非法输入以退出码 1 结束", () => {
  const rules = Array.from({ length: 21 }, () => ({ when: {}, decision: "x" }));
  const input = JSON.stringify({
    attributes: { a: ["v"] },
    policies: { A: { default: "x", rules }, B: { default: "x", rules: [] } },
  });
  const { code, stderr } = runCli(["-"], input);
  assert.equal(code, 1);
  assert.match(stderr, /超过上限 20/);
});
