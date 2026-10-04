/**
 * 手动调度器：为整条调用树限制"在途数"（同时持有占位的任务数）。
 *
 * - capacity 为并行预算，任何时刻 active <= capacity。
 * - manual 模式下，排队等待占位的续体只能通过显式 pump() 获得授权，
 *   测试借此精确驱动调度过程并观测并发峰值。
 */
export class Scheduler {
  readonly capacity: number;
  private available: number;
  private readonly manual: boolean;
  private queue: Array<() => void> = [];

  /** 当前持有占位的任务数 */
  active = 0;
  /** 运行期间观测到的 active 峰值 */
  maxActive = 0;
  /** 累计授权 / 释放次数（用于校验占位不泄漏） */
  totalAcquired = 0;
  totalReleased = 0;

  constructor(options: { capacity: number; manual?: boolean }) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("capacity must be a positive integer");
    }
    this.capacity = options.capacity;
    this.available = options.capacity;
    this.manual = options.manual ?? false;
  }

  /** 正在排队等待占位的续体数 */
  get pending(): number {
    return this.queue.length;
  }

  /** 申请一个占位；有剩余容量时立即（同步）授权，否则排队等待 pump()。 */
  acquire(): Promise<void> {
    if (this.available > 0 && this.queue.length === 0) {
      this.grant();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.manual) queueMicrotask(() => this.pump());
    });
  }

  /** 释放一个占位。 */
  release(): void {
    if (this.active <= 0) throw new Error("release without acquire");
    this.active -= 1;
    this.available += 1;
    this.totalReleased += 1;
    if (!this.manual) queueMicrotask(() => this.pump());
  }

  /** 手动驱动：把剩余容量授权给排队的续体，返回本轮授权数。 */
  pump(): number {
    let granted = 0;
    while (this.available > 0 && this.queue.length > 0) {
      const resolve = this.queue.shift()!;
      this.grant();
      resolve();
      granted += 1;
    }
    return granted;
  }

  private grant(): void {
    this.available -= 1;
    this.active += 1;
    this.totalAcquired += 1;
    if (this.active > this.maxActive) this.maxActive = this.active;
  }
}
