/** 节点状态：存活 / 疑似 / 失效 */
export type NodeState = "alive" | "suspected" | "failed";

/** 探测器发出的探测包 */
export interface Probe {
  nodeId: string;
  seq: number;
  generation: number;
  sentAt: number;
}

/** 节点回包（对探测的应答，回显序号与代际） */
export interface Ack {
  nodeId: string;
  seq: number;
  generation: number;
}

/** 节点对外可见的状态快照（含判定依据） */
export interface NodeStatus {
  id: string;
  state: NodeState;
  /** 当前状态的判定依据（人类可读） */
  reason: string;
  /** 已被有效回包确认的最高心跳序号 */
  heartbeatSeq: number;
  /** 当前探测代际 */
  probeGeneration: number;
  /** 疑似期限（tick）；无未决探测时为 Infinity */
  suspicionDeadline: number;
  /** 失效期限（tick）；无未决探测时为 Infinity */
  failureDeadline: number;
}

/** 监控器事件日志，用于审计与测试断言 */
export type MonitorEvent =
  | { tick: number; kind: "probe-issued"; nodeId: string; seq: number; generation: number }
  | { tick: number; kind: "ack-accepted"; nodeId: string; seq: number; generation: number }
  | { tick: number; kind: "ack-rejected-stale"; nodeId: string; seq: number; generation: number; detail: string }
  | { tick: number; kind: "ack-rejected-terminal"; nodeId: string; seq: number; generation: number }
  | { tick: number; kind: "suspected"; nodeId: string }
  | { tick: number; kind: "failed"; nodeId: string };
