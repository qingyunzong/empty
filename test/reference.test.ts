import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { mulberry32 } from "../src/rng";
import { SimulatedNetwork } from "../src/network";
import { ProbeMonitor } from "../src/monitor";
import { Ack, NodeState } from "../src/types";

/**
 * 单节点参考模型：以独立的直接写法实现同一套规则，
 * 用于与 ProbeMonitor 的实现逐 tick 交叉核验。
 */
interface RefModel {
  state: NodeState;
  heartbeatSeq: number;
  lastIssuedSeq: number;
  generation: number;
  suspicionDeadline: number;
  failureDeadline: number;
  outstanding: boolean;
}

const SUSPICION_TIMEOUT = 3;
const FAILURE_TIMEOUT = 8;
const LAST_PROBE_TICK = 70;
const END_TICK = 90;

function refIssue(model: RefModel, now: number): void {
  model.lastIssuedSeq += 1;
  model.generation += 1;
  model.outstanding = true;
  model.suspicionDeadline = now + SUSPICION_TIMEOUT;
  model.failureDeadline = now + FAILURE_TIMEOUT;
}

function refAdvance(model: RefModel, now: number, acks: Ack[]): void {
  // 同刻先应用回包
  for (const ack of acks) {
    if (model.state === "failed") continue;
    if (
      model.outstanding &&
      ack.generation === model.generation &&
      ack.seq === model.lastIssuedSeq
    ) {
      model.heartbeatSeq = ack.seq;
      model.outstanding = false;
      model.suspicionDeadline = Infinity;
      model.failureDeadline = Infinity;
      model.state = "alive";
    }
  }
  // 再判定超时
  if (model.state !== "failed" && model.outstanding) {
    if (now >= model.failureDeadline) {
      model.state = "failed";
    } else if (now >= model.suspicionDeadline) {
      model.state = "suspected";
    }
  }
}

test("单节点参考核验：随机延迟+丢包场景下逐 tick 与参考模型一致", () => {
  const seeds = [1, 7, 42, 2024, 999983];
  const seenAcrossSeeds = new Set<NodeState>();

  for (const seed of seeds) {
    const rng = mulberry32(seed);
    const monitor = new ProbeMonitor({
      suspicionTimeout: SUSPICION_TIMEOUT,
      failureTimeout: FAILURE_TIMEOUT,
    });
    monitor.registerNode("n1", 0);
    const network = new SimulatedNetwork(rng, 6);

    const ref: RefModel = {
      state: "alive",
      heartbeatSeq: 0,
      lastIssuedSeq: 0,
      generation: 0,
      suspicionDeadline: Infinity,
      failureDeadline: Infinity,
      outstanding: false,
    };
    const seen = new Set<NodeState>();

    for (let t = 0; t <= END_TICK; t++) {
      // 随机决定是否在该 tick 发起新探测（失效后或收尾阶段停止）
      if (ref.state !== "failed" && t <= LAST_PROBE_TICK && rng() < 0.3) {
        const probe = monitor.issueProbe("n1", t);
        // 20% 概率丢包：探测发出但回包永远不会来
        if (rng() >= 0.2) {
          network.send(probe, t);
        }
        refIssue(ref, t);
      }
      const acks = network.deliverDue(t);
      monitor.advance(t, acks);
      refAdvance(ref, t, acks);

      const status = monitor.getStatus("n1");
      equal(status.state, ref.state, `seed=${seed} t=${t} state`);
      equal(status.heartbeatSeq, ref.heartbeatSeq, `seed=${seed} t=${t} heartbeatSeq`);
      equal(status.probeGeneration, ref.generation, `seed=${seed} t=${t} generation`);
      equal(
        status.suspicionDeadline,
        ref.suspicionDeadline,
        `seed=${seed} t=${t} suspicionDeadline`,
      );
      equal(
        status.failureDeadline,
        ref.failureDeadline,
        `seed=${seed} t=${t} failureDeadline`,
      );
      seen.add(status.state);
    }
    equal(network.pending, 0, `seed=${seed} all acks delivered`);
    for (const state of seen) {
      seenAcrossSeeds.add(state);
    }
  }

  // 跨种子应覆盖 存活 / 疑似 / 失效 三种状态
  deepEqual([...seenAcrossSeeds].sort(), ["alive", "failed", "suspected"]);
});

test("每种状态都有非空的判定依据", () => {
  const monitor = new ProbeMonitor({
    suspicionTimeout: SUSPICION_TIMEOUT,
    failureTimeout: FAILURE_TIMEOUT,
  });
  monitor.registerNode("n1", 0);

  monitor.issueProbe("n1", 0);
  monitor.advance(3); // suspected
  equal(monitor.getStatus("n1").reason.length > 0, true);

  monitor.issueProbe("n1", 3);
  monitor.advance(5, [{ nodeId: "n1", seq: 2, generation: 2 }]); // alive
  equal(monitor.getStatus("n1").reason.length > 0, true);

  monitor.issueProbe("n1", 5);
  monitor.advance(13); // failed
  const status = monitor.getStatus("n1");
  equal(status.state, "failed");
  equal(status.reason.length > 0, true);
});
