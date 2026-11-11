/**
 * 只读探测器返回的裁决。
 * - executed:   动作已生效，意图视为成功（可能是“超时后仍成功”的迟到成功）
 * - not_executed: 动作确认未生效，在满足策略时才允许再次执行
 * - unknown:    探测器无法确定状态，必须升级为人工决断，禁止盲目重试
 */
export type ProbeVerdict = "executed" | "not_executed" | "unknown";

export interface ProbeResult {
  verdict: ProbeVerdict;
  /** 可被持久化的只读探测快照/说明，供审计与人工决断使用 */
  detail?: unknown;
}

/** 意图的生命周期状态 */
export type IntentStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "manual_review";

export type ActionOutcome = "success" | "failure" | "manual_review";

export interface IntentResult {
  intentId: string;
  outcome: ActionOutcome;
  status: IntentStatus;
  /** 成功时为动作返回值；失败/人工决断时为 undefined */
  value?: unknown;
  /** 失败原因或人工决断原因 */
  reason?: string;
  /** 真正调用动作函数的次数（用于证明非幂等动作未被盲目重试） */
  attempts: number;
}

/**
 * 持久日志中的一次状态变更。事件只能追加（append-only），
 * 恢复时按 seq 重放重建意图状态。
 */
export type LogEvent =
  | {
      seq: number;
      intentId: string;
      type: "submitted";
      fingerprint: string;
      at: number;
    }
  | {
      seq: number;
      intentId: string;
      type: "action_started";
      attempt: number;
      at: number;
    }
  | {
      seq: number;
      intentId: string;
      type: "action_timed_out";
      attempt: number;
      at: number;
    }
  | {
      seq: number;
      intentId: string;
      type: "probed";
      attempt: number;
      result: ProbeResult;
      at: number;
    }
  | {
      seq: number;
      intentId: string;
      type: "resolved";
      outcome: "success" | "failure";
      attempts: number;
      value?: unknown;
      reason?: string;
      at: number;
    }
  | {
      seq: number;
      intentId: string;
      type: "manual_review";
      attempts: number;
      reason: string;
      detail?: unknown;
      at: number;
    };

/** 可注入的持久日志存储（例如文件、数据库、消息队列实现） */
export interface EventStore {
  /** 读取全部已持久化事件，按 seq 升序 */
  readAll(): Promise<LogEvent[]>;
  /** 原子追加一条事件，返回后必须已持久化 */
  append(event: LogEvent): Promise<void>;
}

export interface IntentHandler {
  /** 页面动作，可能不返回（超时但后台仍在执行） */
  action(): Promise<unknown>;
  /** 只读结果探测器，不允许产生任何副作用 */
  probe(): Promise<ProbeResult>;
}

export interface SubmitOptions {
 intentId: string;
  /** 前置指纹（如页面状态哈希/参数快照），同一 ID 的指纹必须一致 */
  fingerprint: string;
  action(): Promise<unknown>;
  probe(): Promise<ProbeResult>;
  /** 动作超时毫秒数（默认 30000） */
  timeoutMs?: number;
  /** 超时且确认未执行时，最多再执行几次动作（默认 2） */
  maxRetries?: number;
}
