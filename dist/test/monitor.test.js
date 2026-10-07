"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = require("node:assert/strict");
const monitor_1 = require("../src/monitor");
const OPTS = { suspicionTimeout: 3, failureTimeout: 6 };
function newMonitor() {
    const monitor = new monitor_1.ProbeMonitor(OPTS);
    monitor.registerNode("n1", 0);
    return monitor;
}
(0, node_test_1.test)("有效回包确认心跳序号并输出存活依据", () => {
    const monitor = newMonitor();
    const probe = monitor.issueProbe("n1", 0);
    (0, strict_1.deepEqual)({ seq: probe.seq, generation: probe.generation }, { seq: 1, generation: 1 });
    const accepted = monitor.receiveAck({ nodeId: "n1", seq: 1, generation: 1 }, 2);
    (0, strict_1.equal)(accepted, true);
    const status = monitor.getStatus("n1");
    (0, strict_1.equal)(status.state, "alive");
    (0, strict_1.equal)(status.heartbeatSeq, 1);
    (0, strict_1.equal)(status.probeGeneration, 1);
    (0, strict_1.equal)(status.reason, "valid ack seq=1 gen=1 at t=2");
});
(0, node_test_1.test)("旧回包不能清新疑似：旧代际回包被拒，新代际回包才有效", () => {
    const monitor = newMonitor();
    // t=0 发出第 1 代探测，回包迟迟未到
    monitor.issueProbe("n1", 0); // seq=1 gen=1
    monitor.advance(3); // 到达疑似期限
    (0, strict_1.equal)(monitor.getStatus("n1").state, "suspected");
    (0, strict_1.equal)(monitor.getStatus("n1").reason, "no valid ack for seq=1 gen=1 by suspicion deadline t=3");
    // 疑似后重新探测：代际升为 2
    monitor.issueProbe("n1", 3); // seq=2 gen=2
    // 迟到的第 1 代旧回包到达 —— 不得清除疑似
    const staleAccepted = monitor.receiveAck({ nodeId: "n1", seq: 1, generation: 1 }, 4);
    (0, strict_1.equal)(staleAccepted, false);
    (0, strict_1.equal)(monitor.getStatus("n1").state, "suspected");
    (0, strict_1.equal)(monitor.getStatus("n1").heartbeatSeq, 0);
    const staleEvent = monitor.events.find((e) => e.kind === "ack-rejected-stale");
    (0, strict_1.deepEqual)(staleEvent, {
        tick: 4,
        kind: "ack-rejected-stale",
        nodeId: "n1",
        seq: 1,
        generation: 1,
        detail: "stale generation: ack gen=1, current gen=2",
    });
    // 第 2 代有效回包到达 —— 才能清新疑似
    const freshAccepted = monitor.receiveAck({ nodeId: "n1", seq: 2, generation: 2 }, 5);
    (0, strict_1.equal)(freshAccepted, true);
    const status = monitor.getStatus("n1");
    (0, strict_1.equal)(status.state, "alive");
    (0, strict_1.equal)(status.heartbeatSeq, 2);
    (0, strict_1.equal)(status.probeGeneration, 2);
});
(0, node_test_1.test)("旧序号回包与重复回包均被拒绝", () => {
    const monitor = newMonitor();
    monitor.issueProbe("n1", 0); // seq=1 gen=1
    monitor.receiveAck({ nodeId: "n1", seq: 1, generation: 1 }, 1);
    // 重复回包：已无未决探测
    (0, strict_1.equal)(monitor.receiveAck({ nodeId: "n1", seq: 1, generation: 1 }, 2), false);
    const event = monitor.events.at(-1);
    (0, strict_1.deepEqual)(event, {
        tick: 2,
        kind: "ack-rejected-stale",
        nodeId: "n1",
        seq: 1,
        generation: 1,
        detail: "no outstanding probe (ack seq=1 gen=1)",
    });
    (0, strict_1.equal)(monitor.getStatus("n1").state, "alive");
});
(0, node_test_1.test)("同刻有效回包先于超时：回包在疑似期限当刻到达则保持存活", () => {
    const monitor = newMonitor();
    monitor.issueProbe("n1", 0); // 疑似期限 t=3，失效期限 t=6
    // 同一 tick=3：回包与疑似期限同时到期，回包先处理
    monitor.advance(3, [{ nodeId: "n1", seq: 1, generation: 1 }]);
    (0, strict_1.equal)(monitor.getStatus("n1").state, "alive");
    const kinds = monitor.events.map((e) => e.kind);
    (0, strict_1.deepEqual)(kinds, ["probe-issued", "ack-accepted"]); // 无 suspected 事件
});
(0, node_test_1.test)("同刻无回包则按期限进入疑似，再到失效期限则失效", () => {
    const monitor = newMonitor();
    monitor.issueProbe("n1", 0);
    monitor.advance(3);
    (0, strict_1.equal)(monitor.getStatus("n1").state, "suspected");
    monitor.advance(6);
    const status = monitor.getStatus("n1");
    (0, strict_1.equal)(status.state, "failed");
    (0, strict_1.equal)(status.reason, "no valid ack for seq=1 gen=1 by failure deadline t=6");
    // failed 为终态：之后的回包（即使序号代际匹配）也不再生效
    (0, strict_1.equal)(monitor.receiveAck({ nodeId: "n1", seq: 1, generation: 1 }, 7), false);
    (0, strict_1.equal)(monitor.getStatus("n1").state, "failed");
    (0, strict_1.equal)(monitor.events.at(-1)?.kind, "ack-rejected-terminal");
});
(0, node_test_1.test)("疑似期间重新探测会顺延期限，且状态保持疑似直到有效回包", () => {
    const monitor = newMonitor();
    monitor.issueProbe("n1", 0);
    monitor.advance(3); // suspected
    monitor.issueProbe("n1", 3); // 新期限：疑似 t=6，失效 t=9
    monitor.advance(5); // 旧失效期限已过，但新期限未到
    (0, strict_1.equal)(monitor.getStatus("n1").state, "suspected");
    monitor.advance(9); // 到达新失效期限
    (0, strict_1.equal)(monitor.getStatus("n1").state, "failed");
});
(0, node_test_1.test)("多节点状态独立输出", () => {
    const monitor = new monitor_1.ProbeMonitor(OPTS);
    monitor.registerNode("a", 0);
    monitor.registerNode("b", 0);
    monitor.issueProbe("a", 0);
    monitor.issueProbe("b", 0);
    monitor.advance(3, [{ nodeId: "a", seq: 1, generation: 1 }]);
    const all = monitor.getAllStatus();
    (0, strict_1.equal)(all.length, 2);
    (0, strict_1.equal)(all[0]?.state, "alive");
    (0, strict_1.equal)(all[1]?.state, "suspected");
});
