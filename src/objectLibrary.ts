import { ReservationExceededError, TerminalStateError } from "./errors";
import { TenantQuotaLedger } from "./quota";

export type SessionState = "open" | "finished" | "cancelled";

export interface SettleReceipt {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly reservedBytes: number;
  readonly committedBytes: number;
  readonly returnedBytes: number;
}

export interface BeginUploadOptions {
  readonly tenantId: string;
  readonly objectKey: string;
  readonly maxBytes: number;
  readonly generation?: number;
}

let nextSessionSeq = 0;

/**
 * 一次受预留约束的上传会话。
 * 生命周期：open -> finished | cancelled，两个终态互斥，进入其一后另一个及自身均不可再达。
 */
export class UploadSession {
  readonly id: string;
  readonly tenantId: string;
  readonly objectKey: string;
  readonly maxBytes: number;
  readonly generation: number;

  private stateValue: SessionState = "open";
  private publishedBytesValue = 0;

  constructor(
    private readonly ledger: TenantQuotaLedger,
    options: BeginUploadOptions & { readonly id: string },
  ) {
    this.id = options.id;
    this.tenantId = options.tenantId;
    this.objectKey = options.objectKey;
    this.maxBytes = options.maxBytes;
    this.generation = options.generation ?? 0;
  }

  get state(): SessionState {
    return this.stateValue;
  }

  get publishedBytes(): number {
    return this.publishedBytesValue;
  }

  get remainingBytes(): number {
    return this.maxBytes - this.publishedBytesValue;
  }

  /** 发布数据块；累计超过预留上限即拒绝，会话状态保持不变。 */
  publish(bytes: number): void {
    this.assertOpen("publish");
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new RangeError(`publish bytes must be a positive safe integer, got ${bytes}`);
    }
    if (bytes > this.remainingBytes) {
      throw new ReservationExceededError(
        `session ${this.id}: publishing ${bytes}B exceeds remaining reservation ` +
          `${this.remainingBytes}B (max=${this.maxBytes}B, published=${this.publishedBytesValue}B)`,
      );
    }
    this.publishedBytesValue += bytes;
  }

  /** 结束：按实际发布量结算，未用预留归还租户额度。 */
  finish(): SettleReceipt {
    this.assertOpen("finish");
    this.ledger.settle(this.tenantId, this.maxBytes, this.publishedBytesValue);
    this.stateValue = "finished";
    return {
      sessionId: this.id,
      tenantId: this.tenantId,
      objectKey: this.objectKey,
      reservedBytes: this.maxBytes,
      committedBytes: this.publishedBytesValue,
      returnedBytes: this.maxBytes - this.publishedBytesValue,
    };
  }

  /** 取消：全部预留归还租户额度，已发布数据作废。 */
  cancel(): void {
    this.assertOpen("cancel");
    this.ledger.release(this.tenantId, this.maxBytes);
    this.stateValue = "cancelled";
  }

  private assertOpen(op: string): void {
    if (this.stateValue !== "open") {
      throw new TerminalStateError(
        `session ${this.id}: cannot ${op} a ${this.stateValue} session ` +
          `(cancel 和 finish 只能进入一个终态)`,
      );
    }
  }
}

export interface CommittedObject {
  readonly objectKey: string;
  readonly tenantId: string;
  readonly bytes: number;
  readonly sessionId: string;
}

/**
 * 对象库：上传开始前先按最大上传量预留租户额度，
 * 结束按实际发布量结算，取消全额归还；超预留的发布被拒绝。
 */
export class ObjectLibrary {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly committed: CommittedObject[] = [];

  constructor(private readonly ledger: TenantQuotaLedger) {}

  /** 开启上传会话：先预留 maxBytes，预留不足则失败且不产生会话。 */
  beginUpload(options: BeginUploadOptions): UploadSession {
    this.ledger.reserve(options.tenantId, options.maxBytes);
    const id = `upl-${++nextSessionSeq}`;
    const session = new UploadSession(this.ledger, { ...options, id });
    this.sessions.set(id, session);
    return session;
  }

  /** 结束会话并登记成品对象；等价于 session.finish()，由库记录结算结果。 */
  commit(session: UploadSession): SettleReceipt {
    const receipt = session.finish();
    this.committed.push({
      objectKey: receipt.objectKey,
      tenantId: receipt.tenantId,
      bytes: receipt.committedBytes,
      sessionId: receipt.sessionId,
    });
    return receipt;
  }

  getSession(id: string): UploadSession | undefined {
    return this.sessions.get(id);
  }

  committedObjects(): readonly CommittedObject[] {
    return this.committed;
  }
}
