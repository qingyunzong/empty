import * as assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CacheStore,
  ManualExecutor,
  PowerFailure,
  Stage,
  orchestrate,
} from "../src/index.js";
import { makeFixture, tick } from "./helpers.js";

function chainStages(counts: Map<string, number>, outputs: Record<string, () => unknown> = {}): Stage[] {
  const mk = (id: string, deps: string[] = []): Stage => ({
    id,
    deps,
    files: [`${id}.txt`],
    run: () => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return outputs[id] ? outputs[id]() : `${id}-done`;
    },
  });
  return [mk("a"), mk("b", ["a"]), mk("c", ["b"])];
}

test("断电点 P1: 提交中途（tmp 已写、rename 未做）-> 重启后该阶段重跑，不留残骸", async () => {
  const fx = makeFixture();
  fx.writeFile("a.txt", "1");
  fx.writeFile("b.txt", "1");
  fx.writeFile("c.txt", "1");
  const counts = new Map<string, number>();

  // 第一次“进程”：在 b 提交到一半时断电
  let crashed = false;
  const crashingStore = new CacheStore(fx.cacheDir, {
    afterTmpWrite: () => {
      throw new PowerFailure("power cut mid-commit");
    },
  });
  await assert.rejects(
    () => orchestrate(chainStages(counts), { workdir: fx.workdir, cacheDir: fx.cacheDir, store: crashingStore }),
    (err: unknown) => {
      crashed = err instanceof PowerFailure;
      return crashed;
    },
  );
  assert.ok(crashed);
  assert.equal(existsSync(join(fx.cacheDir, "a.json")), false, "a 的提交被中断，未产生记录");
  assert.ok(readdirSync(fx.cacheDir).some((f) => f.startsWith(".tmp.")), "现场留有 tmp 残骸");

  // 重启“进程”：同一 cacheDir，无故障注入
  const report = await orchestrate(chainStages(counts), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.ok(report.ok);
  assert.deepEqual(
    [report.results.a?.status, report.results.b?.status, report.results.c?.status],
    ["ran", "ran", "ran"],
    "断电时未提交成功的阶段全部重跑",
  );
  assert.ok(readdirSync(fx.cacheDir).every((f) => !f.startsWith(".tmp.")), "tmp 残骸已清理");
});

test("断电点 P2: a 已提交、b 未执行 -> 重启后仅 a 复用，b/c 重跑", async () => {
  const fx = makeFixture();
  fx.writeFile("a.txt", "1");
  fx.writeFile("b.txt", "1");
  fx.writeFile("c.txt", "1");
  const counts = new Map<string, number>();

  // 第一次“进程”：可控执行器只跑完 a，然后断电（丢弃执行器与未完成 promise）
  const executor = new ManualExecutor();
  const firstRun = orchestrate(chainStages(counts), {
    workdir: fx.workdir,
    cacheDir: fx.cacheDir,
    executor,
  });
  firstRun.catch(() => {}); // 断电后 promise 被遗弃，避免未处理拒绝
  await tick();
  assert.deepEqual(executor.pending(), ["a"]);
  await executor.step(); // a 完成并提交缓存
  // —— 模拟断电：不再 step，直接废弃 firstRun 与 executor ——

  // 重启“进程”
  const report = await orchestrate(chainStages(counts), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.ok(report.ok);
  assert.deepEqual(
    [report.results.a?.status, report.results.b?.status, report.results.c?.status],
    ["cached", "ran", "ran"],
    "断电前已提交的成功被复用，未执行的后继重跑",
  );
  assert.deepEqual(
    [counts.get("a"), counts.get("b"), counts.get("c")],
    [1, 1, 1],
    "a 只跑过一次",
  );
});

test("断电点 P3: 断电后输入文件变化 -> 过期成功绝不复用", async () => {
  const fx = makeFixture();
  fx.writeFile("a.txt", "before-crash");
  fx.writeFile("b.txt", "1");
  fx.writeFile("c.txt", "1");
  const outputs: Record<string, () => unknown> = { a: () => readFileSync(join(fx.workdir, "a.txt"), "utf8") };
  const counts = new Map<string, number>();

  // 第一次“进程”：a 提交成功后断电
  const executor = new ManualExecutor();
  const firstRun = orchestrate(chainStages(counts, outputs), {
    workdir: fx.workdir,
    cacheDir: fx.cacheDir,
    executor,
  });
  firstRun.catch(() => {});
  await tick();
  await executor.step(); // a 提交，输出基于 "before-crash"
  // —— 断电 ——

  // 断电期间输入发生变化
  fx.writeFile("a.txt", "after-crash");

  // 重启“进程”
  const report = await orchestrate(chainStages(counts, outputs), {
    workdir: fx.workdir,
    cacheDir: fx.cacheDir,
  });
  assert.ok(report.ok);
  assert.equal(report.results.a?.status, "ran", "输入已变化，a 的过期成功不被复用");
  assert.equal(report.results.a?.output, "after-crash");
  assert.equal(report.results.b?.status, "ran");
  assert.equal(counts.get("a"), 2);
});

test("断电点 P4: 手工伪造的过期记录（校验和合法但摘要过期）不被复用", async () => {
  const fx = makeFixture();
  fx.writeFile("a.txt", "current");
  const counts = new Map<string, number>();

  // 用旧输入写入一条“曾经成功”的合法记录
  fx.writeFile("a.txt", "stale");
  const staleStages: Stage[] = [{ id: "a", files: ["a.txt"], run: () => "stale-output" }];
  await orchestrate(staleStages, { workdir: fx.workdir, cacheDir: fx.cacheDir });
  fx.writeFile("a.txt", "current");

  // 新运行：记录校验和完好，但输入摘要已过期
  const liveStages: Stage[] = [
    {
      id: "a",
      files: ["a.txt"],
      run: () => {
        counts.set("a", (counts.get("a") ?? 0) + 1);
        return "fresh-output";
      },
    },
  ];
  const report = await orchestrate(liveStages, { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.equal(report.results.a?.status, "ran");
  assert.equal(report.results.a?.output, "fresh-output", "输出来自本次执行而非过期缓存");
  assert.equal(counts.get("a"), 1);
});

test("结果发布: 运行报告原子落盘且内容完整", async () => {
  const fx = makeFixture();
  fx.writeFile("a.txt", "1");
  const reportPath = join(fx.dir, "report.json");
  const stages: Stage[] = [{ id: "a", files: ["a.txt"], run: () => "done" }];
  const report = await orchestrate(stages, {
    workdir: fx.workdir,
    cacheDir: fx.cacheDir,
    reportPath,
  });
  assert.ok(existsSync(reportPath));
  const onDisk = JSON.parse(readFileSync(reportPath, "utf8")) as { ok: boolean; results: Record<string, { status: string }> };
  assert.equal(onDisk.ok, report.ok);
  assert.equal(onDisk.results.a?.status, "ran");
  assert.ok(readdirSync(fx.dir).every((f) => !f.startsWith(".tmp.")), "报告发布无 tmp 残留");
});
