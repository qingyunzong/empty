import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  KeyedSerialQueue,
  QueueClosedError,
  TaskCancelledError,
} from '../src/index';

describe('KeyedSerialQueue', () => {
  test('同一 key 严格串行，按提交顺序执行', async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    const jobs = Array.from({ length: 20 }, (_, i) =>
      q.submit('k', async () => {
        await delay(Math.random() * 5);
        order.push(`t${i}`);
        return i;
      })
    );
    const results = await Promise.all(jobs);
    assert.deepEqual(
      order,
      Array.from({ length: 20 }, (_, i) => `t${i}`)
    );
    assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i));
  });

  test('不同 key 并行执行（存在时间重叠）', async () => {
    const q = new KeyedSerialQueue();
    let running = 0;
    let maxConcurrent = 0;
    const worker = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(20);
      running--;
    };
    await Promise.all([
      q.submit('a', worker),
      q.submit('b', worker),
      q.submit('c', worker),
    ]);
    assert.ok(maxConcurrent > 1, `expected parallelism, max=${maxConcurrent}`);
  });

  test('同一 key 内部不存在并发', async () => {
    const q = new KeyedSerialQueue();
    let running = 0;
    let maxConcurrent = 0;
    const worker = async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(5);
      running--;
    };
    await Promise.all(Array.from({ length: 10 }, () => q.submit('k', worker)));
    assert.equal(maxConcurrent, 1);
  });

  test('回调内对同 key 再次提交：排到当前任务之后，不死锁', async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    const innerResults: Promise<unknown>[] = [];
    // 在执行中的回调里向同一 key 再提交：应排队而非死锁
    const outer = q.submit('k', async () => {
      order.push('outer-start');
      innerResults.push(
        q.submit('k', async () => {
          order.push('inner');
          return 'inner-result';
        })
      );
      innerResults.push(
        q.submit('k', () => {
          order.push('after');
        })
      );
      order.push('outer-end');
      return 'outer-result';
    });
    const raced = await Promise.race([
      outer.then(() => Promise.all(innerResults)),
      delay(500).then(() => 'DEADLOCK'),
    ]);
    assert.ok(raced !== 'DEADLOCK', 're-entrant submission deadlocked');
    assert.equal(await outer, 'outer-result');
    assert.equal(await innerResults[0], 'inner-result');
    await innerResults[1];
    assert.deepEqual(order, ['outer-start', 'outer-end', 'inner', 'after']);
  });

  test('同步返回与异步 Promise 混用时顺序一致', async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    await Promise.all([
      q.submit('k', () => {
        order.push('sync');
        return 1;
      }),
      q.submit('k', async () => {
        await delay(10);
        order.push('async');
        return 2;
      }),
      q.submit('k', () => {
        order.push('sync2');
        return 3;
      }),
    ]);
    assert.deepEqual(order, ['sync', 'async', 'sync2']);
  });

  test('任务抛错只拒绝自身，不阻塞同 key 后续任务', async () => {
    const q = new KeyedSerialQueue();
    const order: string[] = [];
    const p1 = q.submit('k', () => {
      order.push('boom');
      throw new Error('boom');
    });
    const p2 = q.submit('k', async () => {
      await delay(5);
      order.push('after-sync-throw');
      throw new Error('async boom');
    });
    const p3 = q.submit('k', () => {
      order.push('survivor');
      return 'ok';
    });
    await assert.rejects(p1, /^Error: boom$/);
    await assert.rejects(p2, /^Error: async boom$/);
    assert.equal(await p3, 'ok');
    assert.deepEqual(order, ['boom', 'after-sync-throw', 'survivor']);
  });

  test('close 后拒绝新提交（QueueClosedError）', async () => {
    const q = new KeyedSerialQueue();
    await q.close();
    assert.equal(q.isClosed, true);
    await assert.rejects(q.submit('k', () => 1), QueueClosedError);
  });

  test('close 默认排空：已排队任务全部执行完毕', async () => {
    const q = new KeyedSerialQueue();
    const done: string[] = [];
    const p1 = q.submit('k', async () => {
      await delay(20);
      done.push('first');
    });
    const p2 = q.submit('k', () => {
      done.push('second');
    });
    const p3 = q.submit('k', () => {
      done.push('third');
    });
    const closed = q.close();
    await closed;
    assert.deepEqual(done, ['first', 'second', 'third']);
    await Promise.all([p1, p2, p3]);
  });

  test('close({cancelPending:true})：未开始任务以 TaskCancelledError 拒绝，进行中的完成', async () => {
    const q = new KeyedSerialQueue();
    const done: string[] = [];
    const p1 = q.submit('k', async () => {
      await delay(20);
      done.push('running');
    });
    const p2 = q.submit('k', () => {
      done.push('queued1');
    });
    const p3 = q.submit('k', () => {
      done.push('queued2');
    });
    // 让第一个任务先开始执行
    await delay(0);
    await q.close({ cancelPending: true });
    await p1;
    await assert.rejects(p2, TaskCancelledError);
    await assert.rejects(p3, TaskCancelledError);
    assert.deepEqual(done, ['running']);
  });

  test('close 返回的 Promise 等待所有 key 的任务结束', async () => {
    const q = new KeyedSerialQueue();
    const done: string[] = [];
    void q.submit('a', async () => {
      await delay(30);
      done.push('a');
    });
    void q.submit('b', async () => {
      await delay(10);
      done.push('b');
    });
    await q.close();
    assert.deepEqual(done.sort(), ['a', 'b']);
  });

  test('结果 Promise 按任务各自兑现，值互不错位', async () => {
    const q = new KeyedSerialQueue();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        q.submit('k', async () => {
          await delay((50 - i) % 3);
          return i * 10;
        })
      )
    );
    assert.deepEqual(results, Array.from({ length: 50 }, (_, i) => i * 10));
  });
});
