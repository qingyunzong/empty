import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireAll,
  AcquireTimeoutError,
  type ResourceRequest,
} from '../src/combinedAcquire.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => Promise.resolve();
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Tracked<T> {
  request: ResourceRequest<T>;
  releases: T[];
  signals: AbortSignal[];
}

/** 构造一个可追踪 release 次数/顺序与 signal 状态的请求。 */
function tracked<T>(
  log: string[],
  name: string,
  acquire: (signal: AbortSignal) => Promise<T> | T,
): Tracked<T> {
  const releases: T[] = [];
  const signals: AbortSignal[] = [];
  const request: ResourceRequest<T> = {
    acquire: (signal) => {
      signals.push(signal);
      return acquire(signal);
    },
    release: (resource) => {
      releases.push(resource);
      log.push(`release:${name}`);
    },
  };
  return { request, releases, signals };
}

test('全部成功：按申请顺序返回结果，不释放任何资源', async () => {
  const log: string[] = [];
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const r0 = tracked(log, 'r0', () => d0.promise);
  const r1 = tracked(log, 'r1', () => d1.promise);

  const pending = acquireAll([r0.request, r1.request]);
  // 故意乱序完成，验证返回值仍按申请顺序。
  d1.resolve('one');
  d0.resolve('zero');

  assert.deepEqual(await pending, ['zero', 'one']);
  assert.deepEqual(log, []);
  assert.equal(r0.releases.length, 0);
  assert.equal(r1.releases.length, 0);
});

test('空请求列表：返回空数组', async () => {
  assert.deepEqual(await acquireAll([]), []);
});

test('任一失败：取消其余请求，已成功资源按逆申请顺序释放', async () => {
  const log: string[] = [];
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const r0 = tracked(log, 'r0', () => d0.promise);
  const r1 = tracked(log, 'r1', () => d1.promise);
  const r2 = tracked(log, 'r2', () => d2.promise);
  const failure = new Error('r2 failed');

  const pending = acquireAll([r0.request, r1.request, r2.request]);
  // 完成顺序故意为 r1 -> r0，与申请顺序不同。
  d1.resolve('one');
  await tick();
  d0.resolve('zero');
  await tick();
  d2.reject(failure);

  await assert.rejects(pending, (err) => err === failure);

  // 其余请求收到取消信号。
  assert.equal(r0.signals[0]!.aborted, true);
  assert.equal(r1.signals[0]!.aborted, true);
  // 释放顺序为逆申请顺序（r1 先于 r0），与完成顺序无关。
  assert.deepEqual(log, ['release:r1', 'release:r0']);
  // 每个资源恰好释放一次。
  assert.equal(r0.releases.length, 1);
  assert.equal(r1.releases.length, 1);
  assert.equal(r2.releases.length, 0);
});

test('多个失败：错误选择按申请顺序（下标最小者）', async () => {
  const log: string[] = [];
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const r0 = tracked(log, 'r0', () => d0.promise);
  const r1 = tracked(log, 'r1', () => d1.promise);
  const r2 = tracked(log, 'r2', () => d2.promise);
  const err0 = new Error('fail-0');
  const err1 = new Error('fail-1');
  const err2 = new Error('fail-2');

  const pending = acquireAll([r0.request, r1.request, r2.request]);
  // 失败发生的时间顺序为 r1 -> r2 -> r0。
  d1.reject(err1);
  await tick();
  d2.reject(err2);
  await tick();
  d0.reject(err0);

  // 返回错误按申请顺序选择：下标最小的 err0。
  await assert.rejects(pending, (err) => err === err0);
  assert.deepEqual(log, []);
});

test('超时：视为失败并取消其余，迟到成功必须释放且不改变返回错误', async () => {
  const log: string[] = [];
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const r0 = tracked(log, 'r0', () => d0.promise);
  const r1 = tracked(log, 'r1', () => d1.promise);

  const pending = acquireAll([r0.request, r1.request], { timeoutMs: 20 });
  await sleep(40); // 两个请求均已超时。

  // 超时后 signal 已取消。
  assert.equal(r0.signals[0]!.aborted, true);
  assert.equal(r1.signals[0]!.aborted, true);

  // 迟到成功：在超时之后才 resolve。
  d1.resolve('late-one');
  await tick();
  d0.resolve('late-zero');

  // 返回错误仍是申请序最小的超时错误，迟到成功不改变它。
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof AcquireTimeoutError);
    assert.equal((err as AcquireTimeoutError).index, 0);
    return true;
  });

  // 迟到成功的资源也被释放，逆申请顺序，且各恰好一次。
  assert.deepEqual(log, ['release:r1', 'release:r0']);
  assert.equal(r0.releases.length, 1);
  assert.equal(r1.releases.length, 1);
});

test('迟到失败：不改变已按申请序选定的错误', async () => {
  const log: string[] = [];
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const r0 = tracked(log, 'r0', () => d0.promise);
  const r1 = tracked(log, 'r1', () => d1.promise);
  const lateFailure = new Error('late failure of r1');

  const pending = acquireAll([r0.request, r1.request], { timeoutMs: 20 });
  await sleep(40); // r0 已记录超时错误。

  d0.resolve('zero'); // 迟到成功
  await tick();
  d1.reject(lateFailure); // 迟到失败

  // 下标 0 的超时错误仍是返回错误，迟到失败不改变结果。
  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof AcquireTimeoutError);
    assert.equal((err as AcquireTimeoutError).index, 0);
    return true;
  });
  assert.deepEqual(log, ['release:r0']);
  assert.equal(r0.releases.length, 1);
  assert.equal(r1.releases.length, 0);
});

test('取消后落定的资源：释放恰好一次（手动交错验证）', async () => {
  const log: string[] = [];
  const d0 = deferred<string>();
  const d1 = deferred<string>();
  const d2 = deferred<string>();
  const r0 = tracked(log, 'r0', () => d0.promise);
  const r1 = tracked(log, 'r1', () => d1.promise);
  const r2 = tracked(log, 'r2', () => d2.promise);
  const failure = new Error('boom');

  const pending = acquireAll([r0.request, r1.request, r2.request]);
  d0.resolve('zero'); // 失败前已成功
  await tick();
  d2.reject(failure); // 触发取消
  await tick();
  d1.resolve('one'); // 取消后迟到成功

  await assert.rejects(pending, (err) => err === failure);
  assert.deepEqual(log, ['release:r1', 'release:r0']);
  assert.equal(r0.releases.length, 1);
  assert.equal(r1.releases.length, 1);
  assert.equal(r2.releases.length, 0);
});
