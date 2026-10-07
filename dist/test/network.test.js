"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const rng_1 = require("../src/rng");
const network_1 = require("../src/network");
const monitor_1 = require("../src/monitor");
const simulation_1 = require("../src/simulation");
(0, node_test_1.test)("随机延迟导致回包重排，且最终全部投递", () => {
    const network = new network_1.SimulatedNetwork((0, rng_1.mulberry32)(42), 5);
    const probes = [];
    for (let i = 1; i <= 6; i++) {
        probes.push({ nodeId: "n1", seq: i, generation: i, sentAt: 0 });
    }
    const sendOrder = [];
    for (const probe of probes) {
        network.send(probe, 0);
        sendOrder.push(probe.seq);
    }
    const delivered = [];
    for (let t = 0; t <= 10 && network.pending > 0; t++) {
        for (const ack of network.deliverDue(t)) {
            delivered.push(ack.seq);
        }
    }
    (0, strict_1.deepEqual)(sendOrder, [1, 2, 3, 4, 5, 6]);
    (0, strict_1.notEqual)(delivered.join(","), sendOrder.join(",")); // 确实发生了重排
    (0, strict_1.deepEqual)([...delivered].sort((a, b) => a - b), sendOrder); // 无丢失
    (0, strict_1.equal)(network.pending, 0);
});
(0, node_test_1.test)("重排的旧回包不能清新疑似，监控器最终收敛为存活", () => {
    // 选择能造成重排的种子：第 1 代回包晚于疑似期限到达
    const monitor = new monitor_1.ProbeMonitor({ suspicionTimeout: 3, failureTimeout: 30 });
    monitor.registerNode("n1", 0);
    const network = new network_1.SimulatedNetwork((0, rng_1.mulberry32)(5), 5);
    const sim = new simulation_1.Simulation(monitor, network);
    sim.probe("n1", 0); // seq=1 gen=1，随机延迟
    sim.advanceTo(3); // 第 1 代回包未到 -> 疑似
    (0, strict_1.equal)(monitor.getStatus("n1").state, "suspected");
    sim.probe("n1", 3); // seq=2 gen=2
    // 逐 tick 推进，两代的回包按随机延迟乱序到达
    for (let t = 4; t <= 12; t++) {
        sim.advanceTo(t);
    }
    const status = monitor.getStatus("n1");
    (0, strict_1.equal)(status.state, "alive"); // 第 2 代有效回包最终清新疑似
    (0, strict_1.equal)(status.heartbeatSeq, 2);
    (0, strict_1.equal)(status.probeGeneration, 2);
    // 旧代际回包确实到达过且被拒绝
    (0, strict_1.ok)(monitor.events.some((e) => e.kind === "ack-rejected-stale" && e.generation === 1));
    (0, strict_1.ok)(monitor.events.some((e) => e.kind === "ack-accepted" && e.generation === 2));
    (0, strict_1.equal)(network.pending, 0);
});
