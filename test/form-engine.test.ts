import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FormEngine,
  DependencyCycleError,
  StalePlanError,
  UnsettledFormError,
} from "../index.ts";
import type { Option } from "../index.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("联动下拉：上游变化后按拓扑序重载下游选项与派生值", async () => {
  const catalogs: Record<string, Option[]> = {
    zhejiang: [{ label: "杭州", value: "hz" }],
    jiangsu: [{ label: "南京", value: "nj" }],
  };
  const engine = new FormEngine({
    fields: [
      { name: "province" },
      {
        name: "city",
        dependsOn: ["province"],
        options: async (deps) => catalogs[String(deps.province)] ?? [],
      },
      {
        name: "label",
        dependsOn: ["province", "city"],
        compute: (deps) => `${deps.province}/${deps.city}`,
      },
    ],
  });
  await engine.ready();

  await engine.setValue("province", "zhejiang");
  assert.deepEqual(engine.inspect("city").options, catalogs.zhejiang);

  await engine.setValue("city", "hz");
  assert.equal(engine.inspect("label").value, "zhejiang/hz");

  await engine.setValue("province", "jiangsu");
  assert.deepEqual(engine.inspect("city").options, catalogs.jiangsu);
});

test("异步校验：错误进入字段快照，通过后清除", async () => {
  const engine = new FormEngine({
    fields: [
      {
        name: "email",
        validate: async (value) => {
          await tick();
          return String(value).includes("@") ? [] : ["邮箱格式不正确"];
        },
      },
    ],
  });
  await engine.ready();

  const bad = await engine.setValue("email", "not-an-email");
  assert.deepEqual(bad.errors, ["邮箱格式不正确"]);
  assert.equal(bad.status, "error");

  const good = await engine.setValue("email", "a@b.com");
  assert.deepEqual(good.errors, []);
  assert.equal(good.status, "stable");
});

test("条件区域：visibleWhen 驱动字段与区域可见性", async () => {
  const engine = new FormEngine({
    fields: [
      { name: "applicantType", initial: "personal" },
      {
        name: "taxId",
        dependsOn: ["applicantType"],
        visibleWhen: (deps) => deps.applicantType === "company",
      },
    ],
    sections: [
      {
        name: "companyInfo",
        fields: ["taxId"],
        visibleWhen: (values) => values.applicantType === "company",
      },
    ],
  });
  await engine.ready();
  assert.equal(engine.inspect("taxId").visible, false);
  assert.equal(engine.snapshot().sections[0].visible, false);

  await engine.setValue("applicantType", "company");
  assert.equal(engine.inspect("taxId").visible, true);
  assert.equal(engine.snapshot().sections[0].visible, true);
});

test("世代匹配：被取代的输入以 StalePlanError 拒绝，旧结果不落地", async () => {
  const pending: Array<{ resolve: (o: Option[]) => void; signal: AbortSignal }> = [];
  const engine = new FormEngine({
    fields: [
      { name: "keyword" },
      {
        name: "suggestion",
        dependsOn: ["keyword"],
        options: (_deps, ctx) =>
          new Promise<Option[]>((resolve) => {
            pending.push({ resolve, signal: ctx.signal });
          }),
      },
    ],
  });
  const readyPromise = engine.ready();
  assert.equal(pending.length, 1);
  pending[0].resolve([]);
  await readyPromise;

  const first = engine.setValue("keyword", "a");
  const second = engine.setValue("keyword", "ab");
  assert.equal(pending.length, 3);
  // 上游变化撤销了下游旧计划：第一次加载的 signal 已中止。
  assert.equal(pending[1].signal.aborted, true);
  assert.equal(pending[2].signal.aborted, false);

  // 旧计划的结果更晚才返回，也不得落地。
  pending[1].resolve([{ label: "过期", value: "stale" }]);
  pending[2].resolve([{ label: "最新", value: "fresh" }]);

  await assert.rejects(first, (err) => err instanceof StalePlanError);
  await second;
  assert.deepEqual(engine.inspect("suggestion").options, [{ label: "最新", value: "fresh" }]);
});

test("循环依赖：抛出包含最小环的 DependencyCycleError", () => {
  assert.throws(
    () =>
      new FormEngine({
        fields: [
          { name: "a", dependsOn: ["d"] },
          { name: "b", dependsOn: ["a"] },
          { name: "c", dependsOn: ["b"] },
          { name: "d", dependsOn: ["c"] },
          { name: "x", dependsOn: ["y"] },
          { name: "y", dependsOn: ["x"] },
        ],
      }),
    (err) => {
      assert.ok(err instanceof DependencyCycleError);
      assert.equal(err.cycle.length, 3); // 最小环为 x -> y -> x
      assert.deepEqual(new Set(err.cycle.slice(0, 2)), new Set(["x", "y"]));
      assert.equal(err.cycle[0], err.cycle[2]);
      return true;
    },
  );

  assert.throws(
    () => new FormEngine({ fields: [{ name: "self", dependsOn: ["self"] }] }),
    (err) => err instanceof DependencyCycleError && err.cycle.join("->") === "self->self",
  );
});

test("提交前快照：未稳定时拒绝提交，稳定后生成可复核快照", async () => {
  const gate = deferred<string[]>();
  const engine = new FormEngine({
    fields: [
      {
        name: "username",
        validate: () => gate.promise,
      },
    ],
  });
  const readyPromise = engine.ready();
  assert.throws(() => engine.submit(), UnsettledFormError);

  gate.resolve(["用户名已被占用"]);
  await readyPromise;

  const failed = engine.submit();
  assert.equal(failed.ok, false);
  assert.equal(failed.snapshot.isValid, false);
  assert.equal(failed.snapshot.isSettled, true);
  assert.deepEqual(failed.snapshot.fields[0].errors, ["用户名已被占用"]);

  const engine2 = new FormEngine({ fields: [{ name: "username", initial: "neo" }] });
  await engine2.ready();
  const passed = engine2.submit();
  assert.equal(passed.ok, true);
  assert.equal(passed.snapshot.fields[0].value, "neo");
  assert.equal(typeof passed.snapshot.createdAt, "string");
});

test("未定义字段与重复定义直接报错", async () => {
  assert.throws(
    () => new FormEngine({ fields: [{ name: "a", dependsOn: ["ghost"] }] }),
    /未定义的字段/,
  );
  assert.throws(
    () => new FormEngine({ fields: [{ name: "a" }, { name: "a" }] }),
    /重复定义/,
  );
  const engine = new FormEngine({ fields: [{ name: "a" }] });
  await engine.ready();
  await assert.rejects(engine.setValue("ghost", 1), /未定义的字段/);
});
