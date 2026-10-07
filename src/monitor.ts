import {
  Ack,
  MonitorEvent,
  NodeState,
  NodeStatus,
  Probe,
} from "./types";

export interface MonitorOptions {
  /** 发出探测后多少 tick 未收到有效回包则置为疑似 */
  suspicionTimeout: number;
  /** 发出探测后多少 tick 未收到有效回包则置为失效（须大于 suspicionTimeout） */
  failureTimeout: number;
}

interface NodeRecord {
  id: string;
  state: NodeState;
  reason: string;
  /** 已被有效回包确认的最高心跳序号 */
  heartbeatSeq: number;
  /** 最近一次发出的探测序号 */
  lastIssuedSeq: number;
  /** 当前探测代际；每次重新探测 +1，使旧代际回包失效 */
  probeGeneration: number;
  suspicionDeadline: number;
  failureDeadline: number;
  /** 是否有等待回包的未决探测 */
  probeOutstanding: boolean;
}

/**
 * 探测监控器（确定性核心，不含随机性）。
 *
 * 不变式：
 * - 只有与当前 (lastIssuedSeq, probeGeneration) 完全匹配、且存在未决探测的回包
 *   才是“有效回包”，可清除疑似并推进 heartbeatSeq；
 * - 旧代际 / 旧序号 / 无未决探测的回包一律视为旧回包，不能清新疑似；
 * - advance() 在同一 tick 内先应用全部回包，再判定超时，
 *   因此同刻到达的有效回包优先于超时判定；
 * - failed 为终态，后续回包不再改变状态。
 */
export class ProbeMonitor {
  private readonly nodes = new Map<string, NodeRecord>();
  readonly events: MonitorEvent[] = [];

  constructor(private readonly options: MonitorOptions) {
    if (!(options.suspicionTimeout > 0)) {
      throw new Error("suspicionTimeout must be > 0");
    }
    if (!(options.failureTimeout > options.suspicionTimeout)) {
      throw new Error("failureTimeout must be > suspicionTimeout");
    }
  }

  registerNode(id: string, now: number): void {
    if (this.nodes.has(id)) {
      throw new Error(`node already registered: ${id}`);
    }
    this.nodes.set(id, {
      id,
      state: "alive",
      reason: `registered at t=${now}`,
      heartbeatSeq: 0,
      lastIssuedSeq: 0,
      probeGeneration: 0,
      suspicionDeadline: Infinity,
      failureDeadline: Infinity,
      probeOutstanding: false,
    });
  }

  /** 发出一轮新探测：序号与代际同时 +1，并重置疑似/失效期限。 */
  issueProbe(id: string, now: number): Probe {
    const rec = this.mustGet(id);
    if (rec.state === "failed") {
      throw new Error(`cannot probe failed node: ${id}`);
    }
    rec.lastIssuedSeq += 1;
    rec.probeGeneration += 1;
    rec.probeOutstanding = true;
    rec.suspicionDeadline = now + this.options.suspicionTimeout;
    rec.failureDeadline = now + this.options.failureTimeout;
    const probe: Probe = {
      nodeId: id,
      seq: rec.lastIssuedSeq,
      generation: rec.probeGeneration,
      sentAt: now,
    };
    this.events.push({
      tick: now,
      kind: "probe-issued",
      nodeId: id,
      seq: probe.seq,
      generation: probe.generation,
    });
    return probe;
  }

  /**
   * 处理一个回包。返回是否为有效回包。
   * 旧回包（代际/序号不匹配或无未决探测）被拒绝，绝不清除疑似。
   */
  receiveAck(ack: Ack, now: number): boolean {
    const rec = this.nodes.get(ack.nodeId);
    if (!rec) {
      throw new Error(`unknown node: ${ack.nodeId}`);
    }
    if (rec.state === "failed") {
      this.events.push({
        tick: now,
        kind: "ack-rejected-terminal",
        nodeId: ack.nodeId,
        seq: ack.seq,
        generation: ack.generation,
      });
      return false;
    }
    const staleDetail = this.staleReason(rec, ack);
    if (staleDetail !== null) {
      this.events.push({
        tick: now,
        kind: "ack-rejected-stale",
        nodeId: ack.nodeId,
        seq: ack.seq,
        generation: ack.generation,
        detail: staleDetail,
      });
      return false;
    }
    rec.heartbeatSeq = ack.seq;
    rec.probeOutstanding = false;
    rec.suspicionDeadline = Infinity;
    rec.failureDeadline = Infinity;
    rec.state = "alive";
    rec.reason = `valid ack seq=${ack.seq} gen=${ack.generation} at t=${now}`;
    this.events.push({
      tick: now,
      kind: "ack-accepted",
      nodeId: ack.nodeId,
      seq: ack.seq,
      generation: ack.generation,
    });
    return true;
  }

  /**
   * 推进时钟到 tick `now`。
   * 同一 tick 内：先按投递顺序应用 acks（同刻有效回包先于超时），再判定超时。
   */
  advance(now: number, acks: Ack[] = []): void {
    for (const ack of acks) {
      this.receiveAck(ack, now);
    }
    for (const rec of this.nodes.values()) {
      if (rec.state === "failed" || !rec.probeOutstanding) {
        continue;
      }
      if (now >= rec.failureDeadline) {
        rec.state = "failed";
        rec.reason =
          `no valid ack for seq=${rec.lastIssuedSeq} gen=${rec.probeGeneration} ` +
          `by failure deadline t=${rec.failureDeadline}`;
        this.events.push({ tick: now, kind: "failed", nodeId: rec.id });
      } else if (now >= rec.suspicionDeadline && rec.state !== "suspected") {
        rec.state = "suspected";
        rec.reason =
          `no valid ack for seq=${rec.lastIssuedSeq} gen=${rec.probeGeneration} ` +
          `by suspicion deadline t=${rec.suspicionDeadline}`;
        this.events.push({ tick: now, kind: "suspected", nodeId: rec.id });
      }
    }
  }

  getStatus(id: string): NodeStatus {
    const rec = this.mustGet(id);
    return {
      id: rec.id,
      state: rec.state,
      reason: rec.reason,
      heartbeatSeq: rec.heartbeatSeq,
      probeGeneration: rec.probeGeneration,
      suspicionDeadline: rec.suspicionDeadline,
      failureDeadline: rec.failureDeadline,
    };
  }

  getAllStatus(): NodeStatus[] {
    return [...this.nodes.keys()].map((id) => this.getStatus(id));
  }

  private staleReason(rec: NodeRecord, ack: Ack): string | null {
    if (!rec.probeOutstanding) {
      return `no outstanding probe (ack seq=${ack.seq} gen=${ack.generation})`;
    }
    if (ack.generation !== rec.probeGeneration) {
      return `stale generation: ack gen=${ack.generation}, current gen=${rec.probeGeneration}`;
    }
    if (ack.seq !== rec.lastIssuedSeq) {
      return `stale seq: ack seq=${ack.seq}, current seq=${rec.lastIssuedSeq}`;
    }
    return null;
  }

  private mustGet(id: string): NodeRecord {
    const rec = this.nodes.get(id);
    if (!rec) {
      throw new Error(`unknown node: ${id}`);
    }
    return rec;
  }
}
