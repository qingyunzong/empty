import type { Clock, MonotonicClock, TimerHandle } from "./types.ts";

/** 基于 performance.now() 与真实计时器的生产时钟（浏览器与 Node 均可用）。 */
export class SystemClock implements Clock {
  now(): number {
    return performance.now();
  }

  setTimer(deadlineMs: number, fire: () => void): TimerHandle {
    const delayMs = Math.max(0, deadlineMs - this.now());
    const id = setTimeout(fire, delayMs);
    return { id } as unknown as TimerHandle;
  }

  clearTimer(handle: TimerHandle): void {
    const { id } = handle as unknown as { id: ReturnType<typeof setTimeout> };
    clearTimeout(id);
  }
}

export function createSystemClock(): MonotonicClock & Clock {
  return new SystemClock();
}

interface PendingTimer {
  readonly handle: TimerHandle;
  readonly deadline: number;
  readonly fire: () => void;
}

let nextVirtualHandleId = 1;

/**
 * 虚拟单调时钟：时间只在测试显式推进时前进，到期计时器按期限顺序同步触发。
 * 调用方可以在 advance 之间交错注入文档变化与取消，形成确定性的串行事件序列。
 */
export class VirtualClock implements Clock {
  private currentTime = 0;
  private readonly pending: PendingTimer[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimer(deadlineMs: number, fire: () => void): TimerHandle {
    const handle = {
      virtualTimerId: nextVirtualHandleId++,
    } as unknown as TimerHandle;
    this.pending.push({ handle, deadline: deadlineMs, fire });
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    const index = this.pending.findIndex((entry) => entry.handle === handle);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
  }

  /** 尚未触发的计时器数量，便于测试断言清理是否彻底。 */
  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * 推进虚拟时间到 nowMs，并按期限升序触发所有 deadline <= nowMs 的计时器；
   * 同一期限按注册顺序触发（稳定计时器先于总超时计时器注册）。
   */
  advance(nowMs: number): void {
    if (nowMs < this.currentTime) {
      throw new RangeError("virtual clock cannot move backwards");
    }
    this.currentTime = nowMs;
    const due = this.pending
      .filter((entry) => entry.deadline <= this.currentTime)
      .sort((a, b) => a.deadline - b.deadline);
    for (const entry of due) {
      const stillQueued = this.pending.indexOf(entry) >= 0;
      if (stillQueued) {
        this.pending.splice(this.pending.indexOf(entry), 1);
        entry.fire();
      }
    }
  }
}

/**
 * 不真正清除计时器的虚拟时钟：已被“取消”的旧计时器仍会触发，
 * 用于验证组件仅凭自身状态机即可让迟到回调无法再次完成。
 */
export class LeakyVirtualClock extends VirtualClock {
  override clearTimer(): void {
    // 故意留空：保留所有计时器，模拟迟到/僵尸回调。
  }
}
