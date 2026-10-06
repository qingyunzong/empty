import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { mergeRoundRobin } from "../src/merge";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * A source whose every next() is a manually controlled promise.
 * Counts opens/closes and concurrent in-flight next() calls.
 */
class ControlledSource<T> implements AsyncIterable<T> {
  openCount = 0;
  closeCount = 0;
  maxInFlight = 0;
  private inFlight = 0;
  private queue: Array<Deferred<IteratorResult<T>>> = [];

  [Symbol.asyncIterator](): AsyncIterator<T> {
    this.openCount += 1;
    const source = this;
    return {
      next(): Promise<IteratorResult<T>> {
        source.inFlight += 1;
        source.maxInFlight = Math.max(source.maxInFlight, source.inFlight);
        const deferred = new Deferred<IteratorResult<T>>();
        source.queue.push(deferred);
        deferred.promise.then(
          () => {
            source.inFlight -= 1;
          },
          () => {
            source.inFlight -= 1;
          }
        );
        return deferred.promise;
      },
      return(): Promise<IteratorResult<T>> {
        source.closeCount += 1;
        // A well-behaved source settles its outstanding next() on close.
        for (const deferred of source.queue.splice(0)) {
          deferred.resolve({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private shift(): Deferred<IteratorResult<T>> {
    const deferred = this.queue.shift();
    if (!deferred) throw new Error("no pending prefetch on this source");
    return deferred;
  }

  deliverNext(value: T): void {
    this.shift().resolve({ value, done: false });
  }

  finishNext(): void {
    this.shift().resolve({ value: undefined, done: true });
  }

  failNext(error: unknown): void {
    this.shift().reject(error);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test("结果按源轮转交付，与各项就绪顺序无关", async () => {
  const a = new ControlledSource<string>();
  const b = new ControlledSource<string>();
  const c = new ControlledSource<string>();
  const merged = mergeRoundRobin([a, b, c]);

  // 创建后即每源各预取一项
  equal(a.pendingCount, 1);
  equal(b.pendingCount, 1);
  equal(c.pendingCount, 1);

  // 乱序就绪，交付仍按源轮转
  c.deliverNext("c0");
  a.deliverNext("a0");
  b.deliverNext("b0");

  deepEqual(await merged.next(), { value: "a0", done: false });
  deepEqual(await merged.next(), { value: "b0", done: false });
  deepEqual(await merged.next(), { value: "c0", done: false });

  // 第二轮（每次交付后该源已自动补一次预取）
  b.deliverNext("b1");
  a.deliverNext("a1");
  c.deliverNext("c1");

  deepEqual(await merged.next(), { value: "a1", done: false });
  deepEqual(await merged.next(), { value: "b1", done: false });
  deepEqual(await merged.next(), { value: "c1", done: false });

  a.finishNext();
  b.finishNext();
  c.finishNext();
  deepEqual(await merged.next(), { value: undefined, done: true });
});

test("每源最多一项预取", async () => {
  const a = new ControlledSource<number>();
  const b = new ControlledSource<number>();
  const merged = mergeRoundRobin([a, b]);

  for (let round = 0; round < 5; round += 1) {
    a.deliverNext(round);
    b.deliverNext(round + 100);
    await merged.next();
    await merged.next();
    equal(a.pendingCount, 1);
    equal(b.pendingCount, 1);
  }

  a.finishNext();
  b.finishNext();
  deepEqual(await merged.next(), { value: undefined, done: true });
  equal(a.maxInFlight, 1);
  equal(b.maxInFlight, 1);
});

test("return 与 next 竞争：已交付项优先，其余预取释放", async () => {
  const a = new ControlledSource<string>();
  const b = new ControlledSource<string>();
  const c = new ControlledSource<string>();
  const merged = mergeRoundRobin([a, b, c]);

  a.deliverNext("a0"); // 只有 a 的预取已就绪（已交付）
  await tick();

  const racedNext = merged.next();
  const returned = merged.return!();

  deepEqual(await racedNext, { value: "a0", done: false }); // 已交付项优先
  deepEqual(await returned, { value: undefined, done: true });

  // 其余预取被释放：三个源都恰好关闭一次
  equal(a.closeCount, 1);
  equal(b.closeCount, 1);
  equal(c.closeCount, 1);

  deepEqual(await merged.next(), { value: undefined, done: true });
});

test("重复关闭幂等，资源计数不重复", async () => {
  const a = new ControlledSource<number>();
  const b = new ControlledSource<number>();
  const merged = mergeRoundRobin([a, b]);

  const [r1, r2, r3] = await Promise.all([merged.return!(), merged.return!(), merged.return!()]);
  deepEqual(r1, { value: undefined, done: true });
  deepEqual(r2, { value: undefined, done: true });
  deepEqual(r3, { value: undefined, done: true });
  deepEqual(await merged.return!(), { value: undefined, done: true });

  equal(a.openCount, 1);
  equal(b.openCount, 1);
  equal(a.closeCount, 1);
  equal(b.closeCount, 1);
});

test("源抛错只关闭该源并报告，其余源继续轮转", async () => {
  const a = new ControlledSource<string>();
  const b = new ControlledSource<string>();
  const c = new ControlledSource<string>();
  const errors: Array<{ error: unknown; index: number }> = [];
  const merged = mergeRoundRobin([a, b, c], (error, index) => {
    errors.push({ error, index });
  });

  const boom = new Error("boom");
  a.deliverNext("a0");
  b.failNext(boom);
  c.deliverNext("c0");
  await tick();

  deepEqual(await merged.next(), { value: "a0", done: false });
  deepEqual(await merged.next(), { value: "c0", done: false }); // b 被跳过

  equal(errors.length, 1);
  equal(errors[0]!.error, boom);
  equal(errors[0]!.index, 1);
  equal(b.closeCount, 1); // 出错源被关闭一次

  // 剩余源继续轮转
  a.deliverNext("a1");
  c.deliverNext("c1");
  deepEqual(await merged.next(), { value: "a1", done: false });
  deepEqual(await merged.next(), { value: "c1", done: false });

  // 关闭合并器不会重复关闭已出错的源
  await merged.return!();
  equal(a.closeCount, 1);
  equal(b.closeCount, 1);
  equal(c.closeCount, 1);
});

test("自然耗尽的源不重复关闭，资源计数平衡", async () => {
  const a = new ControlledSource<number>();
  const b = new ControlledSource<number>();
  const merged = mergeRoundRobin([a, b]);

  a.deliverNext(1);
  b.deliverNext(2);
  deepEqual(await merged.next(), { value: 1, done: false });
  deepEqual(await merged.next(), { value: 2, done: false });

  a.finishNext();
  b.finishNext();
  deepEqual(await merged.next(), { value: undefined, done: true });

  // 自然耗尽的源无需再 return()
  equal(a.closeCount, 0);
  equal(b.closeCount, 0);

  // 关闭合并器也不会重复关闭它们
  await merged.return!();
  equal(a.closeCount, 0);
  equal(b.closeCount, 0);
  equal(a.openCount, 1);
  equal(b.openCount, 1);
});

test("for await 与异步生成器互操作", async () => {
  async function* gen(values: number[]): AsyncGenerator<number> {
    for (const value of values) yield value;
  }
  const merged = mergeRoundRobin([gen([1, 2]), gen([10, 20, 30])]);
  const out: number[] = [];
  for await (const value of merged) out.push(value);
  deepEqual(out, [1, 10, 2, 20, 30]);
});

test("生成器源抛错：报告后继续，for await 正常结束", async () => {
  async function* good(): AsyncGenerator<number> {
    yield 1;
    yield 2;
    yield 3;
  }
  async function* bad(): AsyncGenerator<number> {
    yield 10;
    throw new Error("bad source");
  }
  const errors: unknown[] = [];
  const merged = mergeRoundRobin([good(), bad()], (error) => {
    errors.push(error);
  });
  const out: number[] = [];
  for await (const value of merged) out.push(value);
  deepEqual(out, [1, 10, 2, 3]);
  equal(errors.length, 1);
});
