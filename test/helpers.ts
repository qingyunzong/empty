import type { SearchPage } from "../src/merger.js";

/** A promise whose resolution is controlled by the test. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * An async iterable of pages whose delivery is fully controlled by the test:
 * nothing is yielded until `push`/`close` is called, so the test decides the
 * exact order and timing of page arrival.
 */
export class ControlledStream implements AsyncIterable<SearchPage> {
  private readonly buffered: SearchPage[] = [];
  private readonly waiters: Array<(r: IteratorResult<SearchPage>) => void> = [];
  private finished = false;

  push(page: SearchPage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: page, done: false });
    else this.buffered.push(page);
  }

  close(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SearchPage> {
    return {
      next: () => {
        const value = this.buffered.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Yield each deferred's value in array order; tests resolve them in any order. */
export async function* fromDeferreds(
  deferreds: Array<Deferred<SearchPage>>,
): AsyncIterable<SearchPage> {
  for (const d of deferreds) yield await d.promise;
}

/** All permutations of `items` (used to enumerate page arrival orders). */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) out.push([items[i]!, ...perm]);
  }
  return out;
}

/** Let the event loop run one full turn so pending async consumers catch up. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
