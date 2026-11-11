
/**
 * 可控 Promise：测试中手动决定何时 resolve/reject，
 * 用来精确编排“超时后才成功”“探测迟到”等时序。
 */
export class ControlledPromise<T> implements Promise<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T | PromiseLike<T>) => void;
  private rejectFn!: (reason?: unknown) => void;
  settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // 防止超时后迟到的 reject 触发 unhandledRejection（其结果已被探测裁决）
    this.promise.catch(() => {});
  }

  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(value);
  }

  reject(reason?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(reason);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?:
      | ((value: T) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null
      | undefined,
  ): Promise<T | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.promise.finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return "ControlledPromise";
  }
}
