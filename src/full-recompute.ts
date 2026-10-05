/**
 * 对照实现：全量重算。
 *
 * 不做任何依赖跟踪：computed 每次 get 都重新求值；任何 source 变化
 * 都会重新运行所有 effect。用于对照主库的按需（增量）重算。
 */

const listeners = new Set<() => void>();

export interface FSource<T> {
  get(): T;
  set(v: T): void;
}

export interface FComputed<T> {
  get(): T;
  dispose(): void;
}

export interface FEffect {
  dispose(): void;
}

export function source<T>(initial: T): FSource<T> {
  let value = initial;
  return {
    get: () => value,
    set(v: T) {
      if (Object.is(v, value)) return;
      value = v;
      for (const l of [...listeners]) l();
    },
  };
}

export function computed<T>(fn: () => T): FComputed<T> {
  return {
    get: () => fn(),
    dispose: () => {},
  };
}

export function effect(fn: () => void): FEffect {
  listeners.add(fn);
  fn();
  return {
    dispose: () => {
      listeners.delete(fn);
    },
  };
}
