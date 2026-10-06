import test from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Checkpoint, Solver } from "../src/solver.js";
import { mulberry32, randomProblem } from "./helpers.js";

/** 以多种暂停点保存/恢复，最终结果与节点总数必须和不暂停完全一致。 */
test("暂停-恢复后结果与不暂停相同", () => {
  const rng = mulberry32(13579);
  for (let iter = 0; iter < 60; iter++) {
    const p = randomProblem(rng);

    const direct = new Solver(p);
    direct.run();
    const directResult = direct.result();
    const directNodes = direct.nodeCount;

    for (const pauseAt of [1, 3, 17, 100]) {
      const s1 = new Solver(p);
      s1.run(pauseAt);
      const cp: Checkpoint = JSON.parse(JSON.stringify(s1.checkpoint()));
      const s2 = Solver.fromCheckpoint(cp);
      s2.run();
      deepEqual(s2.result(), directResult, `第${iter}例@${pauseAt}步恢复后结果不同`);
      equal(s2.nodeCount, directNodes, `第${iter}例@${pauseAt}步恢复后节点数不同`);
    }
  }
});

test("多级串联保存/恢复（暂停多次）结果一致", () => {
  const rng = mulberry32(424242);
  for (let iter = 0; iter < 20; iter++) {
    const p = randomProblem(rng);
    const direct = new Solver(p);
    direct.run();

    let s = new Solver(p);
    let guard = 0;
    while (!s.done && guard++ < 50) {
      s.run(5);
      const cp: Checkpoint = JSON.parse(JSON.stringify(s.checkpoint()));
      s = Solver.fromCheckpoint(cp);
    }
    s.run();
    deepEqual(s.result(), direct.result());
    equal(s.nodeCount, direct.nodeCount);
  }
});

test("检查点与问题不匹配时拒绝恢复", () => {
  const rng = mulberry32(99);
  const p1 = randomProblem(rng);
  const p2 = randomProblem(rng);
  const s = new Solver(p1);
  s.run(3);
  const cp = s.checkpoint();
  throws(() => Solver.fromCheckpoint(cp, p2), /不匹配/);
  ok(Solver.fromCheckpoint(cp, p1));
});
