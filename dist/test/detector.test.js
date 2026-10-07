"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const detector_1 = require("../src/detector");
const cfg = { suspectTimeout: 5, suspicionTimeout: 10 };
(0, node_test_1.test)("stale-generation ack cannot clear suspicion", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    d.evaluateTimeouts(5);
    strict_1.default.equal(d.status, "SUSPECT");
    strict_1.default.equal(d.suspicionDeadline, 15);
    const accepted = d.receiveAck(6, { generation: 0, heartbeat: 1 });
    strict_1.default.equal(accepted, false);
    strict_1.default.equal(d.status, "SUSPECT");
    strict_1.default.equal(d.suspicionDeadline, 15);
    strict_1.default.match(d.ignoredAcks[0].reason, /stale generation 0/);
});
(0, node_test_1.test)("old heartbeat cannot refresh the node", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    strict_1.default.equal(d.receiveAck(1, { generation: 1, heartbeat: 2 }), true);
    strict_1.default.equal(d.receiveAck(2, { generation: 1, heartbeat: 1 }), false);
    strict_1.default.equal(d.heartbeat, 2);
    strict_1.default.match(d.ignoredAcks[0].reason, /old heartbeat 1 <= applied 2/);
});
(0, node_test_1.test)("valid ack clears suspicion and records rationale", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    d.evaluateTimeouts(5);
    strict_1.default.equal(d.status, "SUSPECT");
    strict_1.default.equal(d.receiveAck(7, { generation: 1, heartbeat: 1 }), true);
    strict_1.default.equal(d.status, "ALIVE");
    strict_1.default.equal(d.suspicionDeadline, null);
    const last = d.transitions[d.transitions.length - 1];
    strict_1.default.equal(last.from, "SUSPECT");
    strict_1.default.equal(last.to, "ALIVE");
    strict_1.default.match(last.reason, /valid ack \(generation 1, heartbeat 1\) cleared suspect/);
});
(0, node_test_1.test)("same-tick valid ack is applied before timeout evaluation", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    d.receiveAck(5, { generation: 1, heartbeat: 1 });
    d.evaluateTimeouts(5);
    strict_1.default.equal(d.status, "ALIVE");
    strict_1.default.equal(d.transitions.length, 0);
});
(0, node_test_1.test)("suspect becomes dead exactly at the suspicion deadline", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    d.evaluateTimeouts(5);
    strict_1.default.equal(d.status, "SUSPECT");
    d.evaluateTimeouts(14);
    strict_1.default.equal(d.status, "SUSPECT");
    d.evaluateTimeouts(15);
    strict_1.default.equal(d.status, "DEAD");
    const last = d.transitions[d.transitions.length - 1];
    strict_1.default.match(last.reason, /suspicion deadline 15 reached/);
});
(0, node_test_1.test)("dead is terminal: later valid acks are ignored", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    d.evaluateTimeouts(5);
    d.evaluateTimeouts(15);
    strict_1.default.equal(d.status, "DEAD");
    strict_1.default.equal(d.receiveAck(16, { generation: 1, heartbeat: 9 }), false);
    strict_1.default.equal(d.status, "DEAD");
    strict_1.default.match(d.ignoredAcks[0].reason, /already DEAD/);
});
(0, node_test_1.test)("every transition carries a non-empty rationale", () => {
    const d = new detector_1.Detector(cfg);
    d.startProbe(0);
    d.evaluateTimeouts(5);
    d.receiveAck(6, { generation: 1, heartbeat: 1 });
    d.startProbe(10);
    d.evaluateTimeouts(15);
    d.evaluateTimeouts(25);
    strict_1.default.ok(d.transitions.length >= 3);
    for (const tr of d.transitions) {
        strict_1.default.ok(tr.reason.length > 0);
        strict_1.default.ok(tr.tick >= 0);
    }
});
