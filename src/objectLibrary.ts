import {
  InvalidStateTransitionError,
  PublishRejectedError,
  UnknownSessionError,
} from "./errors.js";
import { TenantQuota } from "./quota.js";

export type SessionState = "active" | "finished" | "cancelled";

export interface SessionView {
  readonly id: string;
  readonly objectId: string;
  readonly generation: number;
  readonly reservedBytes: number;
  readonly state: SessionState;
  readonly settledBytes: number | null;
}

interface SessionRecord {
  id: string;
  objectId: string;
  generation: number;
  reservedBytes: number;
  state: SessionState;
  settledBytes: number | null;
}

/**
 * 对象库：上传先按最大量预留额度，结束按实际量结算；
 * 取消与结束互斥，会话只能进入唯一终态。
 */
export class ObjectLibrary {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly activeByObject = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private nextSessionSeq = 0;

  constructor(private readonly quota: TenantQuota) {}

  /**
   * 开启上传：按 maxBytes 预留额度。
   * 若同一对象存在在途会话，先将其作废（旧代际，额度归还一次）。
   */
  beginUpload(objectId: string, maxBytes: number): SessionView {
    const previousId = this.activeByObject.get(objectId);
    if (previousId !== undefined) {
      const previous = this.mustGet(previousId);
      if (previous.state === "active") {
        this.quota.release(previous.reservedBytes);
        this.terminate(previous, "cancelled", null);
      }
      this.activeByObject.delete(objectId);
    }

    this.quota.reserve(maxBytes);

    const generation = (this.generations.get(objectId) ?? 0) + 1;
    this.generations.set(objectId, generation);

    const record: SessionRecord = {
      id: `sess-${++this.nextSessionSeq}`,
      objectId,
      generation,
      reservedBytes: maxBytes,
      state: "active",
      settledBytes: null,
    };
    this.sessions.set(record.id, record);
    this.activeByObject.set(objectId, record.id);
    return ObjectLibrary.toView(record);
  }

  /**
   * 结束发布：按实际量结算，预留与实际之差退回额度。
   * 实际量超过预留时拒绝发布，会话保持在途，额度不变。
   */
  finish(sessionId: string, actualBytes: number): SessionView {
    const record = this.mustGet(sessionId);
    this.assertActive(record, "finish");
    if (actualBytes > record.reservedBytes) {
      throw new PublishRejectedError(actualBytes, record.reservedBytes);
    }
    this.quota.settle(record.reservedBytes, actualBytes);
    this.terminate(record, "finished", actualBytes);
    this.clearActive(record);
    return ObjectLibrary.toView(record);
  }

  /** 取消上传：整笔预留退回额度。 */
  cancel(sessionId: string): SessionView {
    const record = this.mustGet(sessionId);
    this.assertActive(record, "cancel");
    this.quota.release(record.reservedBytes);
    this.terminate(record, "cancelled", null);
    this.clearActive(record);
    return ObjectLibrary.toView(record);
  }

  getSession(sessionId: string): SessionView {
    return ObjectLibrary.toView(this.mustGet(sessionId));
  }

  currentGeneration(objectId: string): number {
    return this.generations.get(objectId) ?? 0;
  }

  private terminate(
    record: SessionRecord,
    terminal: Exclude<SessionState, "active">,
    settledBytes: number | null,
  ): void {
    record.state = terminal;
    record.settledBytes = settledBytes;
  }

  private clearActive(record: SessionRecord): void {
    if (this.activeByObject.get(record.objectId) === record.id) {
      this.activeByObject.delete(record.objectId);
    }
  }

  private assertActive(record: SessionRecord, attempted: string): void {
    if (record.state !== "active") {
      throw new InvalidStateTransitionError(record.id, record.state, attempted);
    }
  }

  private mustGet(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (record === undefined) throw new UnknownSessionError(sessionId);
    return record;
  }

  private static toView(record: SessionRecord): SessionView {
    return { ...record };
  }
}
