import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ManualExecutor, orchestrate, Stage } from "../src/index.js";
import { makeFixture, tick } from "./helpers.js";

function counterStage(
  id: string,
  counts: Map<string, number>,
  opts: Partial<Stage> & { output?: () => unknown } = {},
): Stage {
  return {
    id,
    deps: opts.deps,
    files: opts.files,
    version: opts.version,
    run: (ctx) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return opts.output ? opts.output() : `${id}-output`;
    },
  };
}

test("DAG: 依赖先于后继执行，后继收到依赖输出", async () => {
  const fx = makeFixture();
  const events: string[] = [];
  let dInputs: Record<string, unknown> = {};
  const stage = (id: string, deps: string[] = []): Stage => ({
    id,
    deps,
    run: (ctx) => {
      events.push(id);
      if (id === "d") dInputs = ctx.inputs;
      return id.toUpperCase();
    },
  });
  const report = await orchestrate([stage("a"), stage("b", ["a"]), stage("c", ["a"]), stage("d", ["b", "c"])], {
    workdir: fx.workdir,
    cacheDir: fx.cacheDir,
  });
  assert.ok(report.ok);
  assert.ok(events.indexOf("a") < events.indexOf("b"));
  assert.ok(events.indexOf("a") < events.indexOf("c"));
  assert.ok(events.indexOf("b") < events.indexOf("d"));
  assert.ok(events.indexOf("c") < events.indexOf("d"));
  assert.deepEqual(dInputs, { b: "B", c: "C" });
});

test("DAG: 环与未知依赖被拒绝", async () => {
  const fx = makeFixture();
  const cyclic: Stage[] = [
    { id: "a", deps: ["b"], run: () => null },
    { id: "b", deps: ["a"], run: () => null },
  ];
  await assert.rejects(() => orchestrate(cyclic, { workdir: fx.workdir, cacheDir: fx.cacheDir }), /cycle/);
  const missing: Stage[] = [{ id: "a", deps: ["ghost"], run: () => null }];
  await assert.rejects(() => orchestrate(missing, { workdir: fx.workdir, cacheDir: fx.cacheDir }), /unknown stage/);
});

test("缓存: 第二次运行全部复用成功结果，run 不再调用", async () => {
  const fx = makeFixture();
  const counts = new Map<string, number>();
  const stages = () => [
    counterStage("a", counts),
    counterStage("b", counts, { deps: ["a"] }),
    counterStage("c", counts, { deps: ["b"] }),
  ];
  const first = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.deepEqual([first.results.a?.status, first.results.b?.status, first.results.c?.status], ["ran", "ran", "ran"]);
  const second = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.deepEqual(
    [second.results.a?.status, second.results.b?.status, second.results.c?.status],
    ["cached", "cached", "cached"],
  );
  assert.deepEqual([counts.get("a"), counts.get("b"), counts.get("c")], [1, 1, 1]);
  assert.equal(second.results.b?.output, "b-output");
});

test("失效: 输入文件变化仅使相关分支失效", async () => {
  const fx = makeFixture();
  fx.writeFile("a.txt", "v1");
  fx.writeFile("unrelated.txt", "u");
  const counts = new Map<string, number>();
  const stages = () => [
    counterStage("readA", counts, {
      files: ["a.txt"],
      output: () => readFileSync(join(fx.workdir, "a.txt"), "utf8"),
    }),
    counterStage("useA", counts, { deps: ["readA"] }),
    counterStage("other", counts, { files: ["unrelated.txt"] }),
  ];
  await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });

  fx.writeFile("unrelated.txt", "u2");
  const afterUnrelated = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.equal(afterUnrelated.results.readA?.status, "cached");
  assert.equal(afterUnrelated.results.useA?.status, "cached");
  assert.equal(afterUnrelated.results.other?.status, "ran");

  fx.writeFile("a.txt", "v2");
  const afterChange = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.equal(afterChange.results.readA?.status, "ran");
  assert.equal(afterChange.results.useA?.status, "ran");
  assert.equal(afterChange.results.other?.status, "cached");
  assert.deepEqual([counts.get("readA"), counts.get("useA"), counts.get("other")], [2, 2, 2]);
});

test("失败: 仅重跑失败阶段及其后继，无关分支保持缓存", async () => {
  const fx = makeFixture();
  const counts = new Map<string, number>();
  let bFails = true;
  const stages = (): Stage[] => [
    counterStage("a", counts),
    {
      id: "b",
      deps: ["a"],
      run: () => {
        counts.set("b", (counts.get("b") ?? 0) + 1);
        if (bFails) throw new Error("b exploded");
        return "b-ok";
      },
    },
    counterStage("c", counts, { deps: ["b"] }),
    counterStage("d", counts),
  ];
  const first = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.equal(first.ok, false);
  assert.deepEqual(
    [first.results.a?.status, first.results.b?.status, first.results.c?.status, first.results.d?.status],
    ["ran", "failed", "skipped", "ran"],
  );
  assert.match(first.results.b?.error ?? "", /b exploded/);

  bFails = false;
  const second = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.ok(second.ok);
  assert.deepEqual(
    [second.results.a?.status, second.results.b?.status, second.results.c?.status, second.results.d?.status],
    ["cached", "ran", "ran", "cached"],
  );
  assert.deepEqual(
    [counts.get("a"), counts.get("b"), counts.get("c"), counts.get("d")],
    [1, 2, 1, 1],
    "上游 a 与无关分支 d 不重跑",
  );
});

test("传播: 依赖输出变化使后继失效；输出不变则后继复用", async () => {
  const fx = makeFixture();
  const counts = new Map<string, number>();
  let aVersion = "1";
  let aOutput = "same";
  const stages = (): Stage[] => [
    counterStage("a", counts, { version: aVersion, output: () => aOutput }),
    counterStage("b", counts, { deps: ["a"] }),
  ];
  await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });

  aVersion = "2"; // 强制 a 重跑，但输出相同
  const same = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.equal(same.results.a?.status, "ran");
  assert.equal(same.results.b?.status, "cached", "a 输出未变，b 的内容寻址缓存仍有效");

  aVersion = "3";
  aOutput = "changed";
  const changed = await orchestrate(stages(), { workdir: fx.workdir, cacheDir: fx.cacheDir });
  assert.equal(changed.results.a?.status, "ran");
  assert.equal(changed.results.b?.status, "ran", "a 输出变化传播到后继 b");
});

test("可控执行器: ManualExecutor 按队列顺序确定性调度", async () => {
  const fx = makeFixture();
  const executor = new ManualExecutor();
  const stages: Stage[] = [
    { id: "a", run: () => "A" },
    { id: "b", deps: ["a"], run: () => "B" },
    { id: "c", run: () => "C" },
  ];
  const promise = orchestrate(stages, { workdir: fx.workdir, cacheDir: fx.cacheDir, executor });
  await tick();
  assert.deepEqual(executor.pending(), ["a", "c"], "就绪阶段入队，b 等待 a");

  assert.equal(await executor.step(), "a");
  await tick();
  assert.deepEqual(executor.pending(), ["c", "b"], "a 完成后 b 变为就绪");

  await executor.drain();
  const report = await promise;
  assert.ok(report.ok);
  assert.deepEqual(
    [report.results.a?.status, report.results.b?.status, report.results.c?.status],
    ["ran", "ran", "ran"],
  );
});
