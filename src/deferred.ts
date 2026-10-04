/**
 * A "controllable promise": a promise whose settlement is driven externally
 * via resolve()/reject(). Used both internally (slot/take waiters) and by
 * consumers of this library to gate and observe asynchronous ordering.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T | PromiseLike<T>) => void;
  #reject!: (reason?: unknown) => void;
  #settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get settled(): boolean {
    return this.#settled;
  }

  resolve(value: T | PromiseLike<T>): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve(value);
  }

  reject(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(reason);
  }
}

export function deferred<T = void>(): Deferred<T> {
  return new Deferred<T>();
}
