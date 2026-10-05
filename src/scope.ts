export type Acquire<T> = () => T | Promise<T>;
export type Release<T> = (resource: T) => void | Promise<void>;
export type Finalizer = () => void | Promise<void>;

export class ScopeClosedError extends Error {
  constructor(message = "Scope is already closed") {
    super(message);
    this.name = "ScopeClosedError";
  }
}

/**
 * A resource scope.
 *
 * Semantics:
 * - `acquire` registers its finalizer only after the acquisition succeeds.
 * - `close` releases children (newest first) then own entries in LIFO order,
 *   awaiting each finalizer sequentially; every finalizer runs even when
 *   others fail, and all failures are rethrown as a single AggregateError.
 * - `close` is idempotent: concurrent or repeated calls share one cleanup run,
 *   so every finalizer executes exactly once.
 * - An acquisition that resolves after the scope was closed is released
 *   immediately instead of leaking, and the caller gets a ScopeClosedError.
 */
export class Scope {
  private entries: Finalizer[] = [];
  private children: Scope[] = [];
  private open = true;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly parent?: Scope) {
    if (parent) {
      if (!parent.open) throw new ScopeClosedError("Cannot create a child of a closed scope");
      parent.children.push(this);
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Run `body` with a fresh child scope, always closing it afterwards. */
  static async run<T>(body: (scope: Scope) => T | Promise<T>, parent?: Scope): Promise<T> {
    const scope = new Scope(parent);
    let bodyError: unknown;
    let hasBodyError = false;
    let result!: T;
    try {
      result = await body(scope);
    } catch (error) {
      bodyError = error;
      hasBodyError = true;
    }
    let closeError: unknown;
    let hasCloseError = false;
    try {
      await scope.close();
    } catch (error) {
      closeError = error;
      hasCloseError = true;
    }
    if (hasBodyError && hasCloseError) {
      const closeErrors = closeError instanceof AggregateError ? [...closeError.errors] : [closeError];
      throw new AggregateError([bodyError, ...closeErrors], "Scope body failed and cleanup failed");
    }
    if (hasCloseError) throw closeError;
    if (hasBodyError) throw bodyError;
    return result;
  }

  /**
   * Acquire a resource and register its release with this scope.
   * The finalizer is registered only if `make` succeeds. If the scope closes
   * while `make` is still pending, the late resource is released immediately
   * (never escaped) and a ScopeClosedError is thrown to the caller.
   */
  async acquire<T>(make: Acquire<T>, release: Release<T>): Promise<T> {
    if (!this.open) throw new ScopeClosedError();
    const resource = await make();
    if (!this.open) {
      const closed = new ScopeClosedError("Scope closed while acquiring; late resource was released");
      try {
        await release(resource);
      } catch (releaseError) {
        throw new AggregateError([closed, releaseError], "Late release failed after scope close");
      }
      throw closed;
    }
    this.entries.push(() => release(resource));
    return resource;
  }

  /** Register a plain finalizer with this scope. */
  defer(finalizer: Finalizer): void {
    if (!this.open) throw new ScopeClosedError();
    this.entries.push(finalizer);
  }

  /**
   * Close the scope: close child scopes (newest first), then run own
   * finalizers in reverse registration order. Idempotent and exactly-once.
   */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.open = false;
      this.closePromise = this.finalize();
    }
    return this.closePromise;
  }

  private async finalize(): Promise<void> {
    const errors: unknown[] = [];
    for (const child of [...this.children].reverse()) {
      try {
        await child.close();
      } catch (error) {
        errors.push(error);
      }
    }
    const own = this.entries.reverse();
    this.entries = [];
    for (const finalizer of own) {
      try {
        await finalizer();
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} errors during scope cleanup`);
    }
  }
}
