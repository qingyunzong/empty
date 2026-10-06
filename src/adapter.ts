import { StaleGenerationError, TerminalStateError } from "./errors";
import { ObjectLibrary, SettleReceipt, UploadSession } from "./objectLibrary";

type HandleState = "open" | "finished" | "cancelled";

/**
 * 受控上传句柄：绑定一个对象键的一个代际。
 * finish/cancel 幂等——额度对底层账本恰好归还一次；
 * 被新代际取代后（stale）写与结算被拒绝，取消为安全空操作。
 */
export class UploadHandle {
  private handleState: HandleState = "open";
  private stale = false;
  private receipt: SettleReceipt | undefined;

  constructor(
    private readonly library: ObjectLibrary,
    readonly session: UploadSession,
  ) {}

  get tenantId(): string {
    return this.session.tenantId;
  }

  get objectKey(): string {
    return this.session.objectKey;
  }

  get generation(): number {
    return this.session.generation;
  }

  get state(): HandleState {
    return this.handleState;
  }

  get isStale(): boolean {
    return this.stale;
  }

  write(bytes: number): void {
    this.assertCurrent("write");
    this.assertOpen("write");
    this.session.publish(bytes);
  }

  /** 结束结算；重复调用返回同一回执，额度不会二次结算。 */
  finish(): SettleReceipt {
    this.assertCurrent("finish");
    if (this.handleState === "finished") {
      return this.receipt as SettleReceipt;
    }
    if (this.handleState === "cancelled") {
      throw new TerminalStateError(
        `handle gen ${this.generation} for ${this.objectKey}: already cancelled, cannot finish (取消和结束只能一个终态)`,
      );
    }
    this.receipt = this.library.commit(this.session);
    this.handleState = "finished";
    return this.receipt;
  }

  /** 取消；重复取消与被取代后的取消均为空操作，额度恰好归还一次。 */
  cancel(): void {
    if (this.handleState === "cancelled") {
      return;
    }
    if (this.handleState === "finished") {
      throw new TerminalStateError(
        `handle gen ${this.generation} for ${this.objectKey}: already finished, cannot cancel (取消和结束只能一个终态)`,
      );
    }
    this.session.cancel();
    this.handleState = "cancelled";
  }

  /** 由适配器在新代际开启时调用：取消旧代际，保证其预留恰好归还一次。 */
  supersede(): void {
    this.stale = true;
    this.cancel();
  }

  private assertCurrent(op: string): void {
    if (this.stale) {
      throw new StaleGenerationError(
        `handle gen ${this.generation} for ${this.objectKey}: superseded by a newer generation, cannot ${op}`,
      );
    }
  }

  private assertOpen(op: string): void {
    if (this.handleState !== "open") {
      throw new TerminalStateError(
        `handle gen ${this.generation} for ${this.objectKey}: cannot ${op} a ${this.handleState} handle`,
      );
    }
  }
}

/**
 * 受控上传适配器：按对象键管理上传代际。
 * 开启新代际时自动取消旧代际（旧代际取消），
 * 并通过句柄的幂等终态保证额度对账本恰好归还一次。
 */
export class ControlledUploadAdapter {
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, UploadHandle>();

  constructor(private readonly library: ObjectLibrary) {}

  /** 开启某对象键的新一代上传；旧代际（若仍打开）被取消且额度归还一次。 */
  start(tenantId: string, objectKey: string, maxBytes: number): UploadHandle {
    const key = ControlledUploadAdapter.keyOf(tenantId, objectKey);
    const generation = (this.generations.get(key) ?? 0) + 1;

    const previous = this.active.get(key);
    if (previous !== undefined) {
      previous.supersede();
    }

    const session = this.library.beginUpload({ tenantId, objectKey, maxBytes, generation });
    const handle = new UploadHandle(this.library, session);
    this.generations.set(key, generation);
    this.active.set(key, handle);
    return handle;
  }

  currentGeneration(tenantId: string, objectKey: string): number {
    return this.generations.get(ControlledUploadAdapter.keyOf(tenantId, objectKey)) ?? 0;
  }

  activeHandle(tenantId: string, objectKey: string): UploadHandle | undefined {
    return this.active.get(ControlledUploadAdapter.keyOf(tenantId, objectKey));
  }

  private static keyOf(tenantId: string, objectKey: string): string {
    return `${tenantId}|${objectKey}`;
  }
}
