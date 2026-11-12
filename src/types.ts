/**
 * 适配器一次读取或一次变化携带的数据：严格递增的版本号与该版本对应的不可变快照。
 */
export interface VersionedSnapshot<S> {
  readonly version: number;
  readonly snapshot: S;
}

/**
 * 可订阅文档变化的适配器。
 *
 * - {@link PageAdapter.read} 返回当前版本与该版本的不可变快照；
 * - {@link PageAdapter.subscribe} 从指定版本“之后”按版本顺序重放变化，
 *   每个变化携带对应版本的不可变快照；
 * - 因此先 read 再 subscribe(afterVersion = read.version) 不会漏掉两次调用之间的变化。
 */
export interface PageAdapter<S> {
  read(): VersionedSnapshot<S>;
  subscribe(
    afterVersion: number,
    onChange: (event: VersionedSnapshot<S>) => void,
  ): () => void;
}

/** 单调时钟：返回值只增不减，单位由调用方约定（通常为毫秒）。 */
export interface MonotonicClock {
  now(): number;
}

declare const timerHandleBrand: unique symbol;

/** 时钟实现返回的不透明计时器句柄。 */
export interface TimerHandle {
  readonly [timerHandleBrand]: true;
}

/**
 * 单调时钟 + 虚拟/真实计时器能力。
 * 计时器在绝对期限 deadlineMs（与 {@link MonotonicClock.now} 同一时基）触发。
 */
export interface Clock extends MonotonicClock {
  setTimer(deadlineMs: number, fire: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/** 等待组件的终态。任何路径下快照均为触发终态时的最新不可变快照。 */
export type WaitResult<S> =
  | { readonly status: "satisfied"; readonly version: number; readonly snapshot: S }
  | { readonly status: "timeout"; readonly version: number; readonly snapshot: S }
  | { readonly status: "cancelled"; readonly version: number; readonly snapshot: S };

export interface WaitForStableOptions<S> {
  /** 文档变化适配器。 */
  readonly adapter: PageAdapter<S>;
  /** 只依赖整个快照的纯谓词，组件不传入任何额外参数。 */
  readonly predicate: (snapshot: S) => boolean;
  /** 谓词需要连续成立的正时长。 */
  readonly stableForMs: number;
  /** 总超时时长；省略或 Infinity 表示不设总超时。 */
  readonly timeoutMs?: number;
  /** 单调时钟与计时器来源。 */
  readonly clock: Clock;
  /** 可选取消信号。 */
  readonly signal?: AbortSignal;
}
