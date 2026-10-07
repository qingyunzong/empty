import { test } from "node:test";
import assert from "node:assert/strict";
import { Detector } from "../src/detector";

const cfg = { suspectTimeout: 5, suspicionTimeout: 10 };

test("stale-generation ack cannot clear suspicion", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  d.evaluateTimeouts(5);
  assert.equal(d.status, "SUSPECT");
  assert.equal(d.suspicionDeadline, 15);

  const accepted = d.receiveAck(6, { generation: 0, heartbeat: 1 });
  assert.equal(accepted, false);
  assert.equal(d.status, "SUSPECT");
  assert.equal(d.suspicionDeadline, 15);
  assert.match(d.ignoredAcks[0].reason, /stale generation 0/);
});

test("old heartbeat cannot refresh the node", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  assert.equal(d.receiveAck(1, { generation: 1, heartbeat: 2 }), true);
  assert.equal(d.receiveAck(2, { generation: 1, heartbeat: 1 }), false);
  assert.equal(d.heartbeat, 2);
  assert.match(d.ignoredAcks[0].reason, /old heartbeat 1 <= applied 2/);
});

test("valid ack clears suspicion and records rationale", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  d.evaluateTimeouts(5);
  assert.equal(d.status, "SUSPECT");

  assert.equal(d.receiveAck(7, { generation: 1, heartbeat: 1 }), true);
  assert.equal(d.status, "ALIVE");
  assert.equal(d.suspicionDeadline, null);
  const last = d.transitions[d.transitions.length - 1];
  assert.equal(last.from, "SUSPECT");
  assert.equal(last.to, "ALIVE");
  assert.match(last.reason, /valid ack \(generation 1, heartbeat 1\) cleared suspect/);
});

test("same-tick valid ack is applied before timeout evaluation", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  d.receiveAck(5, { generation: 1, heartbeat: 1 });
  d.evaluateTimeouts(5);
  assert.equal(d.status, "ALIVE");
  assert.equal(d.transitions.length, 0);
});

test("suspect becomes dead exactly at the suspicion deadline", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  d.evaluateTimeouts(5);
  assert.equal(d.status, "SUSPECT");

  d.evaluateTimeouts(14);
  assert.equal(d.status, "SUSPECT");
  d.evaluateTimeouts(15);
  assert.equal(d.status, "DEAD");
  const last = d.transitions[d.transitions.length - 1];
  assert.match(last.reason, /suspicion deadline 15 reached/);
});

test("dead is terminal: later valid acks are ignored", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  d.evaluateTimeouts(5);
  d.evaluateTimeouts(15);
  assert.equal(d.status, "DEAD");

  assert.equal(d.receiveAck(16, { generation: 1, heartbeat: 9 }), false);
  assert.equal(d.status, "DEAD");
  assert.match(d.ignoredAcks[0].reason, /already DEAD/);
});

test("every transition carries a non-empty rationale", () => {
  const d = new Detector(cfg);
  d.startProbe(0);
  d.evaluateTimeouts(5);
  d.receiveAck(6, { generation: 1, heartbeat: 1 });
  d.startProbe(10);
  d.evaluateTimeouts(15);
  d.evaluateTimeouts(25);
  assert.ok(d.transitions.length >= 3);
  for (const tr of d.transitions) {
    assert.ok(tr.reason.length > 0);
    assert.ok(tr.tick >= 0);
  }
});
