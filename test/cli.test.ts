import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { runCli } from "../src/app.js";
import { invertChain, parseStep } from "../src/core.js";

interface CliJson {
  target: string;
  steps: string[];
  domain: [string, string];
  intervals: [string, string][];
  count: string;
  verify: {
    limit: string;
    checked: string;
    mismatches: string[];
    boundaryErrors: string[];
    truncated: boolean;
    ok: boolean;
  } | null;
}

test("CLI: JSON 输出与核心算法一致", () => {
  const res = runCli(["150", "3/4", "9/10", "--json"]);
  equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout) as CliJson;
  equal(out.target, "150");
  deepEqual(out.steps, ["3/4", "9/10"]);
  const expected = invertChain([parseStep("3/4"), parseStep("9/10")], 150n);
  deepEqual(
    out.intervals,
    expected.map(([lo, hi]) => [lo.toString(), hi.toString()])
  );
  const verify = out.verify;
  ok(verify !== null && verify.ok, "低价域核验应通过");
  if (verify === null) throw new Error("unreachable");
  equal(verify.mismatches.length, 0);
  equal(verify.boundaryErrors.length, 0);
});

test("CLI: 人类可读输出包含区间与核验信息", () => {
  const res = runCli(["12", "9/10", "4/5"]);
  equal(res.code, 0, res.stderr);
  ok(res.stdout.includes("可接受原价闭区间"), res.stdout);
  ok(res.stdout.includes("低价域逐值前向核验"), res.stdout);
  ok(res.stdout.includes("通过"), res.stdout);
});

test("CLI: 无解金额", () => {
  const res = runCli(["3", "2"]);
  equal(res.code, 0, res.stderr);
  ok(res.stdout.includes("无"), res.stdout);
});

test("CLI: 超过 8 步被拒绝", () => {
  const res = runCli(["10", "1/2", "1/2", "1/2", "1/2", "1/2", "1/2", "1/2", "1/2", "1/2"]);
  equal(res.code, 1);
  ok(res.stderr.includes("8"), res.stderr);
});

test("CLI: 非法折扣步骤被拒绝", () => {
  const res = runCli(["10", "abc"]);
  equal(res.code, 1);
  ok(res.stderr.includes("无效"), res.stderr);
});

test("CLI: 缺少参数被拒绝", () => {
  equal(runCli([]).code, 1);
  equal(runCli(["10"]).code, 1);
});

test("CLI: --verify-limit 0 跳过核验", () => {
  const res = runCli(["150", "3/4", "--json", "--verify-limit", "0"]);
  equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout) as CliJson;
  equal(out.verify, null);
});

test("CLI: 8 步链端到端", () => {
  const res = runCli([
    "12", "9/10", "4/5", "7/8", "1/2", "5/6", "3/4", "2/3", "9/10", "--json",
  ]);
  equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout) as CliJson;
  ok(out.intervals.length > 0, "应当有解");
  ok(out.verify !== null && out.verify.ok);
});

test("CLI: --help 正常退出", () => {
  const res = runCli(["--help"]);
  equal(res.code, 0);
  ok(res.stdout.includes("用法"), res.stdout);
});

test("CLI: --max 调整定义域上界", () => {
  const res = runCli(["500000000000", "1/2", "--json", "--max", "1000000000000"]);
  equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout) as CliJson;
  deepEqual(out.intervals, [["999999999999", "1000000000000"]]);
});
