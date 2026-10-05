import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/main.js";

test("CLI: 基本链路输出证书与枚举对照", () => {
  const { code, out } = runCli(["examples/chain.json"], () => "");
  assert.equal(code, 0, out);
  assert.match(out, /总下载量 250B/);
  assert.match(out, /选包序列: p1 -> p2/);
  assert.match(out, /逐步空间证书/);
  assert.match(out, /全程峰值占用 250B <= 上限 300B/);
  assert.match(out, /对照结果: MATCH/);
});

test("CLI: 字典序并列打破", () => {
  const { code, out } = runCli(["examples/tie.json"], () => "");
  assert.equal(code, 0, out);
  assert.match(out, /选包序列: pkg-a -> pkg-c/);
});

test("CLI: 空间限制排除过大的边", () => {
  const { code, out } = runCli(["examples/tight-space.json"], () => "");
  assert.equal(code, 0, out);
  assert.match(out, /空间排除: big\(需230B\)/);
  assert.match(out, /选包序列: s1 -> s2/);
});

test("CLI: 无可行方案退出码为 2", () => {
  const { code, out } = runCli(["examples/no-plan.json"], () => "");
  assert.equal(code, 2, out);
  assert.match(out, /无可行升级方案/);
});

test("CLI: 标准输入与 --json", () => {
  const input = JSON.stringify({
    start: "a",
    target: "b",
    spaceLimit: 100,
    packages: [{ id: "p", from: "a", to: "b", bytes: 10, peak: 5 }],
  });
  const { code, out } = runCli(["-", "--json"], () => input);
  assert.equal(code, 0, out);
  const parsed = JSON.parse(out) as {
    result: { ok: boolean; sequence: string[]; maxPeak: number };
    enumeration: { best: { cost: number } };
  };
  assert.ok(parsed.result.ok);
  assert.deepEqual(parsed.result.sequence, ["p"]);
  assert.equal(parsed.result.maxPeak, 15);
  assert.equal(parsed.enumeration.best.cost, 10);
});

test("CLI: 非法输入退出码为 1", () => {
  assert.equal(runCli(["-"], () => "{not json").code, 1);
  assert.equal(runCli(["-"], () => JSON.stringify({ start: "a" })).code, 1);
  assert.equal(runCli(["missing-file.json"], () => "").code, 1);
  assert.equal(runCli([], () => "").code, 1);
  assert.equal(runCli(["--bogus"], () => "").code, 1);
});

test("CLI: --no-enumerate 跳过对照", () => {
  const { code, out } = runCli(["examples/chain.json", "--no-enumerate"], () => "");
  assert.equal(code, 0, out);
  assert.ok(!out.includes("枚举对照"));
});

test("CLI: --help 退出码 0", () => {
  const { code, out } = runCli(["--help"], () => "");
  assert.equal(code, 0);
  assert.match(out, /用法: upgrade-plan/);
});
