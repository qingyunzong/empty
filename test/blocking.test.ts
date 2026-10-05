import { test } from "node:test";
import assert from "node:assert";
import { Network } from "../src/network.js";
import { detectCircularWait } from "../src/deadlock.js";

// 下游满时上游保留服务占位：A 的服务完成后若 B 队列满，
// 客户留在 A 的服务台占位，A 无法开始下一位客户的服务，直到 B 腾出位置。
test("downstream full: upstream keeps the server slot occupied", () => {
  const net = new Network({
    seed: 1,
    stations: [
      { id: "A", queueCapacity: 3, servers: 1, serviceMin: 1, serviceMax: 1 },
      { id: "B", queueCapacity: 1, servers: 1, serviceMin: 5, serviceMax: 5 },
    ],
  });

  net.inject(["A", "B"]); // c1
  net.inject(["A", "B"]); // c2
  net.inject(["A", "B"]); // c3

  net.step(); // t1: A starts c1
  net.step(); // t2: c1 completes at A, moves to B, B starts c1 (dur 5); A starts c2
  net.step(); // t3: c2 completes at A, moves to B queue (now full); A starts c3

  const e4 = net.step(); // t4: c3 completes at A but B queue is full -> blocked
  assert.deepEqual(e4.completed, [{ customerId: 3, stationId: "A" }]);
  assert.deepEqual(e4.blocked, [{ customerId: 3, from: "A", to: "B" }]);
  assert.deepEqual(e4.started, []); // A cannot start anyone: slot still occupied

  // c3 keeps occupying A's only server slot while B is busy with c1
  for (let t = 0; t < 3; t++) {
    const ev = net.step();
    assert.deepEqual(
      ev.started.filter((s) => s.stationId === "A"),
      [],
      "A must not start a new service while its slot is held",
    );
    const slot = net.stationState("A").slots[0];
    assert.equal(slot?.id, 3);
    assert.equal(slot?.remaining, 0); // service done, slot held
    assert.equal(net.counts()["A"]?.blocked, 1);
  }

  // blocking is not a circular wait here: B is actively working
  const report = detectCircularWait(net);
  assert.equal(report.cycle.length, 0);
  assert.equal(report.hardDeadlock, false);

  // once c1 departs and c2 enters service, B's queue drains and c3 moves on
  const events = net.run(4);
  const moved = events.flatMap((e) => e.moved);
  assert.ok(moved.some((m) => m.customerId === 3 && m.to === "B"));
  assert.equal(net.counts()["A"]?.blocked, 0);
});
