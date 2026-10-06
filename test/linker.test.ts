import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  bindingKey,
  graphStateEquals,
  link,
  referenceLink,
  verifyFixedPoint,
  type GraphState,
  type ModuleSpec,
} from "../src/linker.js";

const local = (name: string, as?: string) => ({ kind: "local" as const, name, as });
const reexport = (name: string, from: string, as?: string) => ({
  kind: "reexport" as const,
  name,
  from,
  as,
});
const star = (from: string) => ({ kind: "star" as const, from });
const mod = (id: string, exports: ModuleSpec["exports"]): ModuleSpec => ({ id, exports });

function exportMap(state: GraphState, id: string): Map<string, string> {
  const module = state.modules.get(id);
  assert.ok(module, `module ${id} missing`);
  return new Map(
    [...module.exports.entries()].map(([name, info]) => [
      name,
      `${bindingKey(info.binding)} @ ${info.path.join("->")}`,
    ]),
  );
}

function ambiguityMap(state: GraphState, id: string): Map<string, string[]> {
  const module = state.modules.get(id);
  assert.ok(module, `module ${id} missing`);
  return new Map(
    [...module.ambiguities.entries()].map(([name, bs]) => [
      name,
      bs.map(bindingKey).sort(),
    ]),
  );
}

test("本地显式导出与别名", () => {
  const result = link([mod("a", [local("x"), local("y", "z")])]);
  assert.deepEqual(
    exportMap(result.state, "a"),
    new Map([
      ["x", "a#x @ a"],
      ["z", "a#y @ a"],
    ]),
  );
  assert.equal(result.rounds, 2); // 第 1 轮建立导出，第 2 轮确认不变
  assert.ok(verifyFixedPoint([mod("a", [local("x"), local("y", "z")])], result));
});

test("显式再导出链：绑定身份与来源路径", () => {
  const specs = [
    mod("a", [reexport("x", "b")]),
    mod("b", [reexport("x", "c")]),
    mod("c", [local("x")]),
    mod("d", [reexport("x", "c", "w")]),
  ];
  const result = link(specs);
  assert.deepEqual(exportMap(result.state, "a"), new Map([["x", "c#x @ a->b->c"]]));
  assert.deepEqual(exportMap(result.state, "b"), new Map([["x", "c#x @ b->c"]]));
  assert.deepEqual(exportMap(result.state, "c"), new Map([["x", "c#x @ c"]]));
  assert.deepEqual(exportMap(result.state, "d"), new Map([["w", "c#x @ d->c"]]));
  assert.ok(result.rounds >= 3, "链式再导出需要多轮收敛");
  assert.ok(verifyFixedPoint(specs, result));
});

test("显式导出优先于星号导出", () => {
  const specs = [
    mod("a", [local("x"), star("b")]),
    mod("b", [local("x"), local("y")]),
  ];
  const result = link(specs);
  assert.deepEqual(
    exportMap(result.state, "a"),
    new Map([
      ["x", "a#x @ a"], // 显式覆盖星号
      ["y", "b#y @ a->b"],
    ]),
  );
  assert.deepEqual(ambiguityMap(result.state, "a"), new Map());
  assert.ok(verifyFixedPoint(specs, result));
});

test("星号同名来自不同绑定：报歧义且不导出", () => {
  const specs = [
    mod("a", [star("b"), star("c")]),
    mod("b", [local("x"), local("shared")]),
    mod("c", [local("x"), local("shared")]),
  ];
  const result = link(specs);
  assert.deepEqual(exportMap(result.state, "a"), new Map());
  assert.deepEqual(
    ambiguityMap(result.state, "a"),
    new Map([
      ["shared", ["b#shared", "c#shared"]],
      ["x", ["b#x", "c#x"]],
    ]),
  );
  assert.ok(verifyFixedPoint(specs, result));
});

test("星号同名但同一绑定多路径：不歧义", () => {
  const specs = [
    mod("a", [star("b"), star("c")]),
    mod("b", [local("x")]),
    mod("c", [star("b")]),
  ];
  const result = link(specs);
  assert.deepEqual(exportMap(result.state, "a"), new Map([["x", "b#x @ a->b"]]));
  assert.deepEqual(exportMap(result.state, "c"), new Map([["x", "b#x @ c->b"]]));
  assert.deepEqual(ambiguityMap(result.state, "a"), new Map());
  assert.ok(verifyFixedPoint(specs, result));
});

test("再导出别名穿透星号：别名后的同名不歧义", () => {
  const specs = [
    mod("a", [reexport("x", "b", "bx"), star("c")]),
    mod("b", [local("x")]),
    mod("c", [local("x"), local("k")]),
  ];
  const result = link(specs);
  assert.deepEqual(
    exportMap(result.state, "a"),
    new Map([
      ["bx", "b#x @ a->b"],
      ["k", "c#k @ a->c"],
      ["x", "c#x @ a->c"],
    ]),
  );
  assert.deepEqual(ambiguityMap(result.state, "a"), new Map());
  assert.ok(verifyFixedPoint(specs, result));
});

test("循环模块：星号环上的固定点", () => {
  const specs = [
    mod("a", [local("x"), star("b")]),
    mod("b", [star("a"), local("y")]),
  ];
  const result = link(specs);
  assert.deepEqual(
    exportMap(result.state, "a"),
    new Map([
      ["x", "a#x @ a"],
      ["y", "b#y @ a->b"],
    ]),
  );
  assert.deepEqual(
    exportMap(result.state, "b"),
    new Map([
      ["x", "a#x @ b->a"],
      ["y", "b#y @ b"],
    ]),
  );
  assert.ok(result.rounds > 1, "循环图需要多轮才到达固定点");
  assert.ok(verifyFixedPoint(specs, result));
  assert.ok(graphStateEquals(referenceLink(specs), result.state), "参考实现核验一致");
});

test("循环模块：纯再导出环无锚点则不产生导出", () => {
  const specs = [
    mod("a", [reexport("x", "b")]),
    mod("b", [reexport("x", "a")]),
  ];
  const result = link(specs);
  assert.deepEqual(exportMap(result.state, "a"), new Map());
  assert.deepEqual(exportMap(result.state, "b"), new Map());
  assert.ok(verifyFixedPoint(specs, result));
});

test("循环模块：环上歧义沿星号传播并稳定", () => {
  const specs = [
    mod("a", [star("b"), star("c")]),
    mod("b", [local("x"), star("a")]),
    mod("c", [local("x"), star("a")]),
  ];
  const result = link(specs);
  assert.deepEqual(exportMap(result.state, "a"), new Map());
  assert.deepEqual(ambiguityMap(result.state, "a"), new Map([["x", ["b#x", "c#x"]]]));
  // b、c 经星号环看到 a 的视角：x 在 a 处歧义不导出，故 b、c 各自只有本地 x
  assert.deepEqual(exportMap(result.state, "b"), new Map([["x", "b#x @ b"]]));
  assert.deepEqual(exportMap(result.state, "c"), new Map([["x", "c#x @ c"]]));
  assert.ok(verifyFixedPoint(specs, result));
  assert.ok(graphStateEquals(referenceLink(specs), result.state));
});

test("逐轮全图合并 trace：单调增长并在固定点停止", () => {
  const specs = [
    mod("a", [reexport("v", "b"), star("b")]),
    mod("b", [reexport("v", "c"), star("c")]),
    mod("c", [local("v"), local("w")]),
  ];
  const result = link(specs);
  assert.ok(result.trace.length >= 3);
  const sizes = result.trace.map(
    (t) => [...t.state.modules.values()].reduce((n, m) => n + m.exports.size, 0),
  );
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i]! >= sizes[i - 1]!, "逐轮导出总量单调不减");
  }
  const last = result.trace[result.trace.length - 1]!;
  const prev = result.trace[result.trace.length - 2]!;
  assert.ok(graphStateEquals(last.state, prev.state), "末两轮状态相同（固定点）");
  assert.ok(graphStateEquals(last.state, result.state));
  assert.ok(verifyFixedPoint(specs, result));
});

test("综合图：逐轮合并与参考实现逐模块一致", () => {
  const specs = [
    mod("app", [reexport("main", "core", "run"), star("core"), star("util")]),
    mod("core", [local("main"), reexport("helper", "util"), star("loop")]),
    mod("util", [local("helper"), local("main"), star("loop")]),
    mod("loop", [star("core"), local("tick")]),
  ];
  const result = link(specs);
  assert.ok(verifyFixedPoint(specs, result));
  assert.ok(graphStateEquals(referenceLink(specs), result.state));
  // app: run 显式；main 在 core(core#main) 与 util(util#main) 间歧义
  const app = exportMap(result.state, "app");
  assert.equal(app.get("run"), "core#main @ app->core");
  assert.equal(app.get("helper"), "util#helper @ app->core->util");
  assert.equal(app.get("tick"), "loop#tick @ app->core->loop");
  assert.ok(!app.has("main"));
  assert.deepEqual(
    ambiguityMap(result.state, "app").get("main"),
    ["core#main", "util#main"],
  );
});

test("重复模块 id 报错", () => {
  assert.throws(() => link([mod("a", []), mod("a", [])]));
});
