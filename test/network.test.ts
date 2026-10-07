import { test } from "node:test";
import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { mulberry32 } from "../src/rng";
import { SimulatedNetwork } from "../src/network";
import { ProbeMonitor } from "../src/monitor";
import { Simulation } from "../src/simulation";
import { Probe } from "../src/types";

test("随机延迟导致回包重排，且最终全部投递", () => {
  const network = new SimulatedNetwork(mulberry32(42), 5);
  const probes: Probe[] = [];
  for (let i = 1; i <= 6; i++) {
    probes.push({ nodeId: "n1", seq: i, generation: i, sentAt: 0 });
  }
  const sendOrder: number[] = [];
  for (const probe of probes) {
    network.send(probe, 0);
    sendOrder.push(probe.seq);
  }

  const delivered: number[] = [];
  for (let t = 0; t <= 10 && network.pending > 0; t++) {
    for (const ack of network.deliverDue(t)) {
      delivered.push(ack.seq);
    }
  }

  deepEqual(sendOrder, [1, 2, 3, 4, 5, 6]);
  notEqual(delivered.join(","), sendOrder.join(",")); // 确实发生了重排
  deepEqual([...delivered].sort((a, b) => a - b), sendOrder); // 无丢失
  equal(network.pending, 0);
});

test("重排的旧回包不能清新疑似，监控器最终收敛为存活", () => {
  // 选择能造成重排的种子：第 1 代回包晚于疑似期限到达
  const monitor = new ProbeMonitor({ suspicionTimeout: 3, failureTimeout: 30 });
  monitor.registerNode("n1", 0);
  const network = new SimulatedNetwork(mulberry32(5), 5);
  const sim = new Simulation(monitor, network);

  sim.probe("n1", 0); // seq=1 gen=1，随机延迟
  sim.advanceTo(3); // 第 1 代回包未到 -> 疑似
  equal(monitor.getStatus("n1").state, "suspected");

  sim.probe("n1", 3); // seq=2 gen=2
  // 逐 tick 推进，两代的回包按随机延迟乱序到达
  for (let t = 4; t <= 12; t++) {
    sim.advanceTo(t);
  }

  const status = monitor.getStatus("n1");
  equal(status.state, "alive"); // 第 2 代有效回包最终清新疑似
  equal(status.heartbeatSeq, 2);
  equal(status.probeGeneration, 2);
  // 旧代际回包确实到达过且被拒绝
  ok(
    monitor.events.some(
      (e) => e.kind === "ack-rejected-stale" && e.generation === 1,
    ),
  );
  ok(monitor.events.some((e) => e.kind === "ack-accepted" && e.generation === 2));
  equal(network.pending, 0);
});
