import { StaleGenerationError } from "./errors.js";
import { ObjectLibrary, SessionView } from "./objectLibrary.js";

export interface UploadHandle {
  readonly objectId: string;
  readonly sessionId: string;
  readonly generation: number;
}

/**
 * 受控上传适配器：面向调用方的安全门面。
 * - 额度归还一次：cancel 幂等，重复取消不再归还额度；
 * - 旧代际取消：被取代的旧句柄 cancel 为无操作，不触碰新会话额度；
 * - 旧代际发布：直接拒绝，防止旧句柄误写新代际对象。
 */
export class ControlledUploadAdapter {
  private readonly currentGeneration = new Map<string, number>();
  private readonly terminatedHandles = new Set<string>();

  constructor(private readonly library: ObjectLibrary) {}

  /** 开始上传；同对象旧句柄即刻失效（旧代际）。 */
  start(objectId: string, maxBytes: number): UploadHandle {
    const session = this.library.beginUpload(objectId, maxBytes);
    this.currentGeneration.set(objectId, session.generation);
    return {
      objectId,
      sessionId: session.id,
      generation: session.generation,
    };
  }

  /** 发布：仅当前代际句柄可用；超预留由对象库拒绝，额度保持不变。 */
  publish(handle: UploadHandle, actualBytes: number): SessionView {
    this.assertCurrent(handle);
    const view = this.library.finish(handle.sessionId, actualBytes);
    this.terminatedHandles.add(handle.sessionId);
    return view;
  }

  /**
   * 取消：幂等。返回 true 表示本次真正归还了额度；
   * 重复取消或旧代际取消返回 false，额度不再变动。
   */
  cancel(handle: UploadHandle): boolean {
    if (this.terminatedHandles.has(handle.sessionId)) return false;
    if (!this.isCurrent(handle)) return false;
    this.library.cancel(handle.sessionId);
    this.terminatedHandles.add(handle.sessionId);
    return true;
  }

  private isCurrent(handle: UploadHandle): boolean {
    return this.currentGeneration.get(handle.objectId) === handle.generation;
  }

  private assertCurrent(handle: UploadHandle): void {
    if (!this.isCurrent(handle)) {
      throw new StaleGenerationError(
        handle.objectId,
        handle.generation,
        this.currentGeneration.get(handle.objectId) ?? 0,
      );
    }
  }
}
