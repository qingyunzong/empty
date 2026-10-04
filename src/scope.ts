export type Finalizer = () => void | Promise<void>;

export class ScopeClosedError extends Error {
  constructor(message = "Scope is already closed") {
    super(message);
    this.name = "ScopeClosedError";
  }
}

type ScopeState = "open" | "closing" | "closed";

/**
 * 资源作用域:登记获取成功的资源及其释放器,关闭时按逆序清理全部,
 * 清理错误聚合为 AggregateError;关闭后迟到的异步获取会被立即回收。
 */
export class Scope {
  private finalizers: Finalizer[] = [];
  private state: ScopeState = "open";
  private closingPromise: Promise<void> | null = null;

  get isClosed(): boolean {
    return this.state !== "open";
  }

  /**
   * 在新建作用域中执行 body。body 抛错时先逆序清理全部资源,
   * 清理错误与 body 错误一起聚合为 AggregateError 抛出。
   */
  static async run<T>(body: (scope: Scope) => Promise<T> | T): Promise<T> {
    const scope = new Scope();
    let result: T;
    try {
      result = await body(scope);
    } catch (bodyError) {
      let closeError: unknown = null;
      try {
        await scope.close();
      } catch (err) {
        closeError = err;
      }
      if (closeError !== null) {
        const cleanupErrors =
          closeError instanceof AggregateError ? closeError.errors : [closeError];
        throw new AggregateError(
          [bodyError, ...cleanupErrors],
          "Scope body failed and cleanup also failed",
        );
      }
      throw bodyError;
    }
    await scope.close();
    return result;
  }

  /**
   * 创建子作用域,并作为终结器登记到父作用域:父关闭时子先被关闭。
   * 父已关闭时,子作用域出生即关闭。
   */
  child(): Scope {
    const childScope = new Scope();
    if (this.state === "open") {
      this.finalizers.push(() => childScope.close());
    } else {
      void childScope.close();
    }
    return childScope;
  }

  /**
   * 获取资源并登记释放器。获取失败(同步抛错或 Promise 拒绝)时不登记;
   * 获取完成前作用域已关闭的,立即执行释放并抛出 ScopeClosedError,
   * 保证迟到的资源不会逃逸。
   */
  async acquire<T>(
    acquire: () => T | Promise<T>,
    release: (resource: T) => void | Promise<void>,
  ): Promise<T> {
    if (this.state !== "open") {
      throw new ScopeClosedError();
    }
    const resource = await acquire();
    if (this.state !== "open") {
      await release(resource);
      throw new ScopeClosedError(
        "Acquisition completed after the scope was closed; the resource has been released",
      );
    }
    // 检查与登记之间无 await,不会被 close 插入,保证释放恰好一次。
    this.finalizers.push(() => release(resource));
    return resource;
  }

  /**
   * 关闭作用域:按登记的逆序执行全部终结器,单个终结器失败不中断其余清理,
   * 所有清理错误聚合为 AggregateError 抛出。并发/重复调用共享同一次清理。
   */
  close(): Promise<void> {
    if (this.closingPromise !== null) {
      return this.closingPromise;
    }
    this.state = "closing";
    this.closingPromise = (async () => {
      const errors: unknown[] = [];
      while (this.finalizers.length > 0) {
        const finalizer = this.finalizers.pop()!;
        try {
          await finalizer();
        } catch (err) {
          errors.push(err);
        }
      }
      this.state = "closed";
      if (errors.length > 0) {
        throw new AggregateError(errors, "Errors occurred during scope cleanup");
      }
    })();
    return this.closingPromise;
  }
}
