import { test } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCli } from "../src/cli.js";

test("CLI: 目标偏离且无决议时退出码 1，输出逐项决议与未解冲突", () => {
  const { code, output } = runCli([
    "--base", "examples/base.json",
    "--source", "examples/source.json",
    "--target", "examples/target.json",
  ]);
  assert.equal(code, 1);
  assert.ok(output.includes("批次已应用: 否"));
  assert.ok(output.includes("未解冲突 (2)"));
  assert.ok(output.includes("alpha.status"));
  assert.ok(output.includes("beta.owner"));
});

test("CLI: 提供显式决议后退出码 0 并写出合并结果", () => {
  const out = "dist/cli-test-out.json";
  const { code, output } = runCli([
    "--base", "examples/base.json",
    "--source", "examples/source.json",
    "--target", "examples/target.json",
    "--resolutions", "examples/resolutions.json",
    "--out", out,
  ]);
  assert.equal(code, 0);
  assert.ok(output.includes("批次已应用: 是"));
  const merged = JSON.parse(readFileSync(out, "utf8")) as Record<string, Record<string, unknown>>;
  assert.equal(merged["alpha"]?.["status"], "done");
  assert.equal(merged["alpha"]?.["name"], "Alpha-2");
  assert.equal(merged["beta"]?.["owner"], "lin");
  assert.equal(merged["gamma"]?.["name"], "Gamma");
});

test("CLI: 缺少必填参数时退出码 2，文件不存在时退出码 2", () => {
  assert.equal(runCli(["--source", "examples/source.json"]).code, 2);
  const missing = runCli([
    "--base", "examples/nope.json",
    "--source", "examples/source.json",
    "--target", "examples/target.json",
  ]);
  assert.equal(missing.code, 2);
  assert.ok(missing.output.includes("无法读取 JSON 文件"));
});
