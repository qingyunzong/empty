export interface Deferred<V> {
  readonly promise: Promise<V>;
  resolve(value: V | PromiseLike<V>): void;
  reject(reason?: unknown): void;
}

export function deferred<V>(): Deferred<V> {
  let resolve!: (value: V | PromiseLike<V>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
