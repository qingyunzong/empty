import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCli } from "../src/cli";

function run(args: string[], stdinText = "") {
  return runCli(args, () => stdinText);
}

test("CLI：悬空 else 报告移入-归约冲突与最短符号路径", () => {
  const r = run(["examples/dangling-else.txt"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /移入-归约冲突/);
  assert.match(r.out, /终结符 `e`/);
  assert.match(r.out, /最短符号路径: i i S/);
  assert.match(r.out, /所有项目集与自动机状态一致/);
});

test("CLI：LR(1) 非 LALR(1) 文法不计合并引入的冲突", () => {
  const r = run(["examples/lalr-merge.txt"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /无冲突：该文法是 LR\(1\) 文法/);
  assert.match(r.out, /合并引入（不计入原文法冲突）/);
});

test("CLI：表达式文法无冲突", () => {
  const r = run(["examples/expr.txt"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /无冲突/);
  assert.match(r.out, /状态数: \d+/);
});

test("CLI：从标准输入读取文法", () => {
  const r = run([], "S -> i S e S\nS -> i S\nS -> a\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /移入-归约冲突/);
});

test("CLI：--states 打印状态，--lalr 打印合并明细", () => {
  const r = run(["--states", "--lalr", "examples/lalr-merge.txt"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /状态 #0:/);
  assert.match(r.out, /LALR 冲突 1:.*合并引入（非原文法冲突）/);
});

test("CLI：--no-verify 跳过前缀核对", () => {
  const r = run(["--no-verify", "examples/expr.txt"]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /前缀枚举核对/);
});

test("CLI：超过 20 条产生式报错", () => {
  const prods = "S -> " + Array.from({ length: 21 }, (_, i) => `t${i}`).join(" | ") + "\n";
  const r = run([], prods);
  assert.equal(r.code, 1);
  assert.match(r.err, /超过上限 20/);
});

test("CLI：非法输入报错", () => {
  const r = run([], "这不是文法\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /无法解析/);
});

test("CLI：--help 显示帮助", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /用法/);
});

test("CLI：真实子进程入口（若沙箱允许）", (t) => {
  // 沙箱可能禁止 spawn node；允许时验证编译产物可独立运行
  if (typeof require === "undefined") {
    t!.skip("无 require，跳过子进程入口测试");
    return;
  }
  const cp = require("node:child_process") as {
    spawnSync(cmd: string, args: string[], opts: { encoding: string }): {
      status: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    };
  };
  const r = cp.spawnSync(process.argv[0], ["dist/src/cli.js", "examples/dangling-else.txt"], {
    encoding: "utf8",
  });
  if (r.error || (r.status === 0 && r.stdout.length === 0 && r.stderr.length === 0)) {
    t!.skip("沙箱禁止 spawn node，跳过子进程入口测试");
    return;
  }
  assert.equal(r.status, 0);
  assert.match(r.stdout, /移入-归约冲突/);
});
