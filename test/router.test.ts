import test from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/router.js";

test("会话绑定节点当前代际并计入该代际负载", () => {
  const router = new Router();
  router.addNode("a");
  const s1 = router.openSession();
  assert.deepEqual(s1, { id: s1.id, nodeId: "a", generation: 0 });
  assert.equal(router.getLoad("a"), 1);
  assert.equal(router.getLoad("a", 0), 1);
  assert.deepEqual(router.getSession(s1.id), { id: s1.id, nodeId: "a", generation: 0 });
});

test("新会话按权重最小负载选择节点", () => {
  const router = new Router();
  router.addNode("a", 2);
  router.addNode("b", 1);
  for (let i = 0; i < 6; i += 1) router.openSession();
  assert.equal(router.getLoad("a"), 4);
  assert.equal(router.getLoad("b"), 2);
});

test("节点故障时会话切到按权重最小负载的健康节点", () => {
  const router = new Router();
  router.addNode("a");
  router.addNode("b");
  router.addNode("c");
  const s1 = router.openSession();
  const s2 = router.openSession();
  const s3 = router.openSession();
  assert.equal(s1.nodeId, "a");
  assert.equal(s2.nodeId, "b");
  assert.equal(s3.nodeId, "c");

  const result = router.applyHealthEvents([{ nodeId: "a", healthy: false }]);
  assert.deepEqual(result.reconnected, [s1.id]);
  assert.deepEqual(router.getSession(s1.id), { id: s1.id, nodeId: "b", generation: 0 });
  assert.equal(router.getLoad("a", 0), 0);
  assert.equal(router.getLoad("b"), 2);
  assert.equal(router.getLoad("c"), 1);
  assert.deepEqual(router.getSession(s2.id), { id: s2.id, nodeId: "b", generation: 0 });
});

test("恢复节点升代际但不抢已有会话，仅吸引新会话", () => {
  const router = new Router();
  router.addNode("a");
  router.addNode("b");
  const s1 = router.openSession();
  const s2 = router.openSession();
  assert.equal(s1.nodeId, "a");
  assert.equal(s2.nodeId, "b");

  router.applyHealthEvents([{ nodeId: "a", healthy: false }]);
  assert.equal(router.getSession(s1.id)?.nodeId, "b");
  assert.equal(router.getLoad("b"), 2);

  const recovered = router.applyHealthEvents([{ nodeId: "a", healthy: true }]);
  assert.deepEqual(recovered.reconnected, []);
  assert.equal(router.getGeneration("a"), 1);
  assert.equal(router.getSession(s1.id)?.nodeId, "b");
  assert.equal(router.getSession(s2.id)?.nodeId, "b");
  assert.equal(router.getLoad("a"), 0);
  assert.equal(router.getLoad("b"), 2);

  const s3 = router.openSession();
  assert.deepEqual(router.getSession(s3.id), { id: s3.id, nodeId: "a", generation: 1 });
});

test("关闭会话只减其绑定代际的负载", () => {
  const router = new Router();
  router.addNode("a");
  const s1 = router.openSession();
  assert.equal(router.getLoad("a", 0), 1);

  router.applyHealthEvents([{ nodeId: "a", healthy: false }]);
  router.applyHealthEvents([
    { nodeId: "a", healthy: true },
    { nodeId: "a", healthy: false },
  ]);
  assert.equal(router.getGeneration("a"), 1);
  assert.deepEqual(router.getSession(s1.id), { id: s1.id, nodeId: "a", generation: 0 });
  assert.equal(router.getLoad("a", 0), 1);
  assert.equal(router.getLoad("a", 1), 0);

  assert.equal(router.closeSession(s1.id), true);
  assert.equal(router.getLoad("a", 0), 0);
  assert.equal(router.getLoad("a", 1), 0);
  assert.equal(router.closeSession(s1.id), false);
});

test("重连后的关闭只影响新绑定，不触碰旧节点新代际", () => {
  const router = new Router();
  router.addNode("a");
  router.addNode("b");
  const s1 = router.openSession();
  assert.equal(s1.nodeId, "a");

  router.applyHealthEvents([{ nodeId: "a", healthy: false }]);
  assert.equal(router.getSession(s1.id)?.nodeId, "b");
  router.applyHealthEvents([{ nodeId: "a", healthy: true }]);
  const s2 = router.openSession();
  assert.deepEqual(router.getSession(s2.id), { id: s2.id, nodeId: "a", generation: 1 });

  assert.equal(router.closeSession(s1.id), true);
  assert.equal(router.getLoad("b", 0), 0);
  assert.equal(router.getLoad("a", 1), 1);
  assert.equal(router.getLoad("a", 0), 0);
});

test("批量健康事件原子应用：含未知节点则整批拒绝", () => {
  const router = new Router();
  router.addNode("a");
  router.addNode("b");
  const s1 = router.openSession();
  assert.equal(s1.nodeId, "a");

  assert.throws(
    () =>
      router.applyHealthEvents([
        { nodeId: "a", healthy: false },
        { nodeId: "ghost", healthy: true },
      ]),
    /unknown node: ghost/,
  );
  assert.equal(router.isHealthy("a"), true);
  assert.equal(router.isHealthy("b"), true);
  assert.deepEqual(router.getSession(s1.id), { id: s1.id, nodeId: "a", generation: 0 });
  assert.equal(router.getLoad("a"), 1);
  assert.equal(router.getLoad("b"), 0);
});

test("无健康节点时会话保留旧绑定，恢复后按会话表重连", () => {
  const router = new Router();
  router.addNode("a");
  const s1 = router.openSession();

  const failed = router.applyHealthEvents([{ nodeId: "a", healthy: false }]);
  assert.deepEqual(failed.reconnected, []);
  assert.deepEqual(router.getSession(s1.id), { id: s1.id, nodeId: "a", generation: 0 });
  assert.throws(() => router.openSession(), /no healthy node available/);

  const recovered = router.applyHealthEvents([{ nodeId: "a", healthy: true }]);
  assert.deepEqual(recovered.reconnected, [s1.id]);
  assert.deepEqual(router.getSession(s1.id), { id: s1.id, nodeId: "a", generation: 1 });
  assert.equal(router.getLoad("a", 0), 0);
  assert.equal(router.getLoad("a", 1), 1);
});

test("负载计数与会话表重算结果一致", () => {
  const router = new Router();
  router.addNode("a", 3);
  router.addNode("b", 2);
  router.addNode("c", 1);
  const ids: string[] = [];
  for (let i = 0; i < 12; i += 1) ids.push(router.openSession().id);

  router.applyHealthEvents([
    { nodeId: "a", healthy: false },
    { nodeId: "b", healthy: false },
  ]);
  router.applyHealthEvents([{ nodeId: "a", healthy: true }]);
  router.closeSession(ids[0]!);
  router.closeSession(ids[5]!);
  router.applyHealthEvents([{ nodeId: "b", healthy: true }]);
  for (let i = 0; i < 4; i += 1) ids.push(router.openSession().id);
  router.closeSession(ids[ids.length - 1]!);

  const perNodeGen = new Map<string, number>();
  for (const session of router.listSessions()) {
    const key = `${session.nodeId}#${session.generation}`;
    perNodeGen.set(key, (perNodeGen.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const nodeId of ["a", "b", "c"]) {
    const generation = router.getGeneration(nodeId);
    for (let gen = 0; gen <= generation; gen += 1) {
      const expected = perNodeGen.get(`${nodeId}#${gen}`) ?? 0;
      assert.equal(router.getLoad(nodeId, gen), expected, `${nodeId}#${gen}`);
      total += router.getLoad(nodeId, gen);
    }
  }
  assert.equal(total, router.listSessions().length);
});
