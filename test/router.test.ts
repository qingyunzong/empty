import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { GenerationRouter } from "../src/router.js";

describe("session binding to node generation", () => {
  test("open session binds to current generation and increments load", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    const s = r.openSession("s1");
    assert.deepEqual(s, { id: "s1", nodeId: "a", generation: 1 });
    assert.equal(r.getNode("a")?.load, 1);
    assert.equal(r.verify().ok, true);
  });

  test("weighted least-load: heavier weight attracts more sessions", () => {
    const r = new GenerationRouter([
      { id: "big", weight: 3 },
      { id: "small", weight: 1 },
    ]);
    for (let i = 0; i < 8; i++) r.openSession(`s${i}`);
    assert.equal(r.getNode("big")?.load, 6);
    assert.equal(r.getNode("small")?.load, 2);
    assert.equal(r.verify().ok, true);
  });

  test("duplicate session id rejected", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    r.openSession("s1");
    assert.throws(() => r.openSession("s1"));
  });
});

describe("failover only on failure", () => {
  test("sessions stay put when a node recovers (no stealing)", () => {
    const r = new GenerationRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ]);
    r.openSession("s1");
    r.openSession("s2");
    r.applyHealthEvents([{ type: "down", nodeId: "b" }]);
    r.applyHealthEvents([{ type: "up", nodeId: "b" }]);
    assert.equal(r.getSession("s1")?.nodeId, "a");
    assert.equal(r.getSession("s2")?.nodeId, "b");
    assert.equal(r.getNode("b")?.load, 0);
    assert.equal(r.getNode("a")?.load, 1);
    assert.equal(r.verify().ok, true);
  });

  test("reconnect after failure moves session to a healthy node at its current generation", () => {
    const r = new GenerationRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 2 },
      { id: "c", weight: 1 },
    ]);
    r.openSession("s1");
    r.applyHealthEvents([{ type: "down", nodeId: r.getSession("s1")!.nodeId }]);
    const next = r.reconnect("s1");
    assert.equal(r.getNode(next.nodeId)?.healthy, true);
    assert.equal(r.getNode(next.nodeId)?.generation, next.generation);
    assert.equal(r.getNode(next.nodeId)?.load, 1);
    assert.equal(r.verify().ok, true);
  });

  test("reconnect picks weighted least-loaded among healthy nodes only", () => {
    const r = new GenerationRouter([
      { id: "a", weight: 100 },
      { id: "b", weight: 1 },
    ]);
    r.openSession("s1");
    r.applyHealthEvents([{ type: "down", nodeId: "a" }]);
    const next = r.reconnect("s1");
    assert.equal(next.nodeId, "b");
    assert.equal(r.verify().ok, true);
  });

  test("reconnect of unknown session throws", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    assert.throws(() => r.reconnect("nope"));
  });
});

describe("close only decrements the bound generation", () => {
  test("normal close decrements current generation load", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    r.openSession("s1");
    assert.equal(r.closeSession("s1"), true);
    assert.equal(r.getNode("a")?.load, 0);
    assert.equal(r.verify().ok, true);
  });

  test("stale close after generation bump does not touch new generation load", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    r.openSession("s1");
    r.applyHealthEvents([{ type: "down", nodeId: "a" }]);
    r.applyHealthEvents([{ type: "up", nodeId: "a" }]);
    r.openSession("s2");
    assert.equal(r.getNode("a")?.load, 1);
    assert.equal(r.closeSession("s1"), true);
    assert.equal(r.getNode("a")?.load, 1);
    assert.equal(r.verify().ok, true);
  });

  test("closing unknown session is a no-op", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    assert.equal(r.closeSession("ghost"), false);
    assert.equal(r.getNode("a")?.load, 0);
  });
});

describe("atomic batch health events", () => {
  test("valid batch applies all events together", () => {
    const r = new GenerationRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ]);
    r.applyHealthEvents([
      { type: "down", nodeId: "a" },
      { type: "down", nodeId: "b" },
    ]);
    assert.equal(r.getNode("a")?.healthy, false);
    assert.equal(r.getNode("b")?.healthy, false);
    assert.equal(r.getNode("a")?.generation, 2);
    assert.equal(r.getNode("b")?.generation, 2);
  });

  test("batch with unknown node is rejected wholesale", () => {
    const r = new GenerationRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ]);
    r.openSession("s1");
    const before = r.listNodes();
    assert.throws(() =>
      r.applyHealthEvents([
        { type: "down", nodeId: "a" },
        { type: "down", nodeId: "ghost" },
      ]),
    );
    assert.deepEqual(r.listNodes(), before);
    assert.equal(r.getNode("a")?.healthy, true);
    assert.equal(r.getNode("a")?.generation, 1);
    assert.equal(r.verify().ok, true);
  });

  test("batch with invalid event type is rejected wholesale", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    const before = r.listNodes();
    assert.throws(() =>
      r.applyHealthEvents([{ type: "flap" as never, nodeId: "a" }]),
    );
    assert.deepEqual(r.listNodes(), before);
  });
});

describe("session-table verification", () => {
  test("verify passes after mixed reconnects and stale closes", () => {
    const r = new GenerationRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ]);
    r.openSession("s1");
    r.openSession("s2");
    r.openSession("s3");
    const downHost = r.getSession("s1")!.nodeId;
    r.applyHealthEvents([{ type: "down", nodeId: downHost }]);
    for (const s of r.listSessions()) {
      if (s.nodeId === downHost && s.id !== "s3") r.reconnect(s.id);
    }
    r.closeSession("s3");
    assert.equal(r.verify().ok, true);
  });

  test("reconcile repairs drifted counters from the session table", () => {
    const r = new GenerationRouter([{ id: "a", weight: 1 }]);
    r.openSession("s1");
    r.openSession("s2");
    const internal = r as unknown as { nodes: Map<string, { load: number }> };
    internal.nodes.get("a")!.load = 99;
    const report = r.reconcile();
    assert.equal(report.ok, false);
    assert.deepEqual(report.discrepancies, [
      { nodeId: "a", generation: 1, tracked: 99, recomputed: 2 },
    ]);
    assert.equal(r.getNode("a")?.load, 2);
    assert.equal(r.verify().ok, true);
  });
});
