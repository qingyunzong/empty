import { test } from "node:test";
import assert from "node:assert";
import { Network } from "../src/network.js";
import { detectCircularWait } from "../src/deadlock.js";

// 循环等待：A 的服务台占位客户要去 B，B 满；B 的服务台占位客户要去 A，A 满。
// 检测报告必须给出证据链（经过的客户与服务台）。
test("circular wait is detected and reported with evidence", () => {
  const net = new Network({
    seed: 1,
    stations: [
      { id: "A", queueCapacity: 1, servers: 1, serviceMin: 1, serviceMax: 1 },
      { id: "B", queueCapacity: 1, servers: 1, serviceMin: 1, serviceMax: 1 },
    ],
  });

  net.inject(["A", "B"]); // c1 -> will block at A waiting for B
  net.inject(["B", "A"]); // c2 -> will block at B waiting for A

  net.step(); // t1: A starts c1, B starts c2

  // fill both bounded queues while c1/c2 occupy the servers
  net.inject(["A", "B"]); // c3 -> fills A's queue
  net.inject(["B", "A"]); // c4 -> fills B's queue

  const e2 = net.step(); // t2: both complete, both blocked
  assert.deepEqual(e2.blocked, [
    { customerId: 1, from: "A", to: "B" },
    { customerId: 2, from: "B", to: "A" },
  ]);

  const report = detectCircularWait(net);
  assert.equal(report.edges.length, 2);
  assert.equal(report.cycle.length, 2);
  assert.deepEqual([...report.stations].sort(), ["A", "B"]);
  assert.equal(report.hardDeadlock, true);

  // evidence chain names the stations and the customers held hostage
  assert.ok(report.summary.includes("A -[customer 1]-> B"));
  assert.ok(report.summary.includes("B -[customer 2]-> A"));
  assert.ok(report.summary.includes("hard deadlock"));

  // a hard circular wait never resolves: nothing completes/moves/starts again
  for (let i = 0; i < 5; i++) {
    const ev = net.step();
    assert.deepEqual(ev.completed, []);
    assert.deepEqual(ev.moved, []);
    assert.deepEqual(ev.departed, []);
    assert.deepEqual(ev.started, []);
  }
  assert.equal(net.departed, 0);
  assert.equal(net.customerCount(), 4);
});
