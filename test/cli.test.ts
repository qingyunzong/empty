import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CLI = join(process.cwd(), "dist", "src", "cli.js");
const SAMPLE = join(process.cwd(), "examples", "sample.json");

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

test("CLI run：示例文件端到端求解并通过核验", async () => {
  const r = await runCli(["run", SAMPLE, "--verify"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /下单向量:/);
  assert.match(r.stdout, /枚举核验: 一致/);
  assert.match(r.stdout, /逐时段缺货验证:/);
  assert.match(r.stdout, /穷举核验: 一致/);
});

test("CLI solve --json 输出结构化结果", async () => {
  const r = await runCli(["solve", SAMPLE, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { feasible: boolean; quantities: number[] };
  assert.equal(parsed.feasible, true);
  assert.ok(Array.isArray(parsed.quantities));
});

test("CLI schedule：独立排程模式", async () => {
  const dir = mkdtempSync(join(tmpdir(), "procure-"));
  const file = join(dir, "sched.json");
  writeFileSync(
    file,
    JSON.stringify({
      quantities: [10, 20],
      slots: [
        { capacity: 30, demand: 10 },
        { capacity: 30, demand: 20 },
      ],
    }),
  );
  const r = await runCli(["schedule", file, "--verify"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /总缺货: 0/);
  assert.match(r.stdout, /穷举核验: 一致/);
});

test("CLI：缺参数与非法输入返回非零", async () => {
  assert.notEqual((await runCli([])).code, 0);
  assert.notEqual((await runCli(["solve", "/nonexistent.json"])).code, 0);
  const dir = mkdtempSync(join(tmpdir(), "procure-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ demand: 10, maxTotal: 5, suppliers: [{ name: "A", minQty: 1, maxQty: 10, tiers: [{ upTo: 10, unitPrice: 1 }] }] }));
  const r = await runCli(["solve", bad]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /错误:/);
});
