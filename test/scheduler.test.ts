import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClockBackwardsError,
  LogicalScheduler,
  type EventKind,
  type RunResult,
  type TraceEntry,
} from '../src/scheduler';

test('推进逻辑时间只交付已到期 I/O', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleIO(5, 'a');
  scheduler.scheduleIO(10, 'b');
  scheduler.scheduleIO(15, 'c');

  const result = scheduler.advanceTo(10);

  assert.equal(result.delivered, 2);
  assert.equal(result.exhausted, false);
  assert.equal(scheduler.now(), 10);
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['a', 'b'],
  );
  assert.equal(scheduler.pendingCount(), 1);

  scheduler.advanceTo(15);
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['a', 'b', 'c'],
  );
});

test('微任务按注册 ID 序执行', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleMicrotask('m1');
  scheduler.scheduleIO(0, 'io-same-tick');
  scheduler.scheduleMicrotask('m2');

  scheduler.tick(0);

  assert.deepEqual(
    scheduler.trace().map((entry) => [entry.id, entry.label]),
    [
      [1, 'm1'],
      [2, 'io-same-tick'],
      [3, 'm2'],
    ],
  );
});

test('同刻新增事件放队尾', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleIO(0, 'first', () => {
    scheduler.scheduleMicrotask('spawned-micro');
    scheduler.scheduleIO(0, 'spawned-io');
  });
  scheduler.scheduleMicrotask('second');

  scheduler.advanceTo(0);

  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['first', 'second', 'spawned-micro', 'spawned-io'],
  );
});

test('单刻预算超限后可续跑', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleMicrotask('m1');
  scheduler.scheduleMicrotask('m2');
  scheduler.scheduleMicrotask('m3');
  scheduler.scheduleMicrotask('m4');

  const first = scheduler.advanceTo(0, 2);
  assert.deepEqual(first, { delivered: 2, remaining: 2, exhausted: true });
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['m1', 'm2'],
  );

  const second = scheduler.resume(1);
  assert.deepEqual(second, { delivered: 1, remaining: 1, exhausted: true });

  const third = scheduler.resume();
  assert.deepEqual(third, { delivered: 1, remaining: 0, exhausted: false });
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['m1', 'm2', 'm3', 'm4'],
  );
});

test('续跑期间新增的同刻事件计入续跑预算', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleMicrotask('parent', () => {
    scheduler.scheduleMicrotask('child');
  });
  scheduler.scheduleMicrotask('sibling');

  const first = scheduler.advanceTo(0, 1);
  assert.deepEqual(first, { delivered: 1, remaining: 2, exhausted: true });

  const second = scheduler.resume(1);
  assert.deepEqual(second, { delivered: 1, remaining: 1, exhausted: true });
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['parent', 'sibling'],
  );

  scheduler.resume();
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['parent', 'sibling', 'child'],
  );
});

test('拒绝后退时钟且状态保持不变', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleIO(3, 'early');
  scheduler.advanceTo(10);

  assert.throws(() => scheduler.advanceTo(9), ClockBackwardsError);
  assert.throws(() => scheduler.tick(-1));

  assert.equal(scheduler.now(), 10);
  scheduler.scheduleIO(0, 'late');
  scheduler.advanceTo(10);
  assert.deepEqual(
    scheduler.trace().map((entry) => [entry.time, entry.label]),
    [
      [3, 'early'],
      [10, 'late'],
    ],
  );
});

test('输出时间及交付轨迹', () => {
  const scheduler = new LogicalScheduler();
  scheduler.scheduleIO(5, 'pay');
  scheduler.scheduleMicrotask('sync');

  scheduler.advanceTo(5);

  assert.deepEqual(scheduler.trace(), [
    { time: 0, id: 2, kind: 'microtask', label: 'sync' },
    { time: 5, id: 1, kind: 'io', label: 'pay' },
  ]);
  assert.equal(scheduler.formatTrace(), 't=0 #2 microtask:sync\nt=5 #1 io:pay');
});

test('取消：已取消事件不交付，重复或未知取消返回 false', () => {
  const scheduler = new LogicalScheduler();
  const target = scheduler.scheduleIO(5, 'x');
  scheduler.scheduleIO(5, 'y');

  assert.equal(scheduler.cancel(target), true);
  assert.equal(scheduler.cancel(target), false);
  assert.equal(scheduler.cancel(999), false);

  const result = scheduler.advanceTo(5);
  assert.equal(result.delivered, 1);
  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['y'],
  );
  assert.equal(scheduler.cancel(2), false);
});

test('交付中可重入取消同刻靠后的事件', () => {
  const scheduler = new LogicalScheduler();
  let victim = 0;
  scheduler.scheduleMicrotask('canceller', () => {
    assert.equal(scheduler.cancel(victim), true);
  });
  victim = scheduler.scheduleMicrotask('victim');

  scheduler.tick(0);

  assert.deepEqual(
    scheduler.trace().map((entry) => entry.label),
    ['canceller'],
  );
});

interface ModelEvent {
  id: number;
  time: number;
  kind: EventKind;
  label: string;
  cancelled: boolean;
  done: boolean;
}

/**
 * 独立的列表模型：不排序、不搬移，交付时反复全表扫描
 * 选取 (time, id) 最小的存活到期事件，用于交叉核验调度器。
 */
class ListModel {
  private currentTime = 0;
  private nextId = 1;
  private readonly events: ModelEvent[] = [];
  readonly delivered: TraceEntry[] = [];

  now(): number {
    return this.currentTime;
  }

  schedule(time: number, kind: EventKind, label: string): number {
    const event: ModelEvent = {
      id: this.nextId++,
      time,
      kind,
      label,
      cancelled: false,
      done: false,
    };
    this.events.push(event);
    return event.id;
  }

  cancel(id: number): boolean {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event || event.cancelled || event.done) {
      return false;
    }
    event.cancelled = true;
    return true;
  }

  pending(): number {
    return this.events.filter((event) => !event.cancelled && !event.done).length;
  }

  advanceTo(time: number, budget: number, onDeliver: (id: number) => void): RunResult {
    assert.ok(time >= this.currentTime, 'model clock must not go backwards');
    this.currentTime = time;
    return this.run(budget, onDeliver);
  }

  resume(budget: number, onDeliver: (id: number) => void): RunResult {
    return this.run(budget, onDeliver);
  }

  private run(budget: number, onDeliver: (id: number) => void): RunResult {
    let delivered = 0;
    while (delivered < budget) {
      let best: ModelEvent | undefined;
      for (const event of this.events) {
        if (event.cancelled || event.done || event.time > this.currentTime) {
          continue;
        }
        if (!best || event.time < best.time || (event.time === best.time && event.id < best.id)) {
          best = event;
        }
      }
      if (!best) {
        break;
      }
      best.done = true;
      this.delivered.push({ time: best.time, id: best.id, kind: best.kind, label: best.label });
      delivered += 1;
      onDeliver(best.id);
    }
    const remaining = this.events.filter(
      (event) => !event.cancelled && !event.done && event.time <= this.currentTime,
    ).length;
    return { delivered, remaining, exhausted: remaining > 0 };
  }
}

test('列表模型核验取消及重入', () => {
  let state = 0x2f6e2b1;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
  const randInt = (bound: number): number => Math.floor(rand() * bound);

  interface Plan {
    spawnMicro: boolean;
    spawnIoDelay: number;
    cancelOffset: number;
  }
  const planFor = (id: number): Plan => {
    const hash = (id * 2654435761) >>> 0;
    return {
      spawnMicro: hash % 2 === 0,
      spawnIoDelay: (hash >>> 3) % 3 === 0 ? (hash >>> 5) % 4 : -1,
      cancelOffset: (hash >>> 7) % 5,
    };
  };

  const scheduler = new LogicalScheduler();
  const model = new ListModel();

  const schedulerHandler = (getId: () => number) => () => {
    const id = getId();
    const plan = planFor(id);
    if (plan.spawnMicro) {
      spawnSchedulerMicrotask(`m<-${id}`);
    }
    if (plan.spawnIoDelay >= 0) {
      spawnSchedulerIO(plan.spawnIoDelay, `io<-${id}`);
    }
    if (plan.cancelOffset > 0) {
      scheduler.cancel(id + plan.cancelOffset);
    }
  };

  const spawnSchedulerMicrotask = (label: string): number => {
    let id = 0;
    id = scheduler.scheduleMicrotask(label, schedulerHandler(() => id));
    return id;
  };
  const spawnSchedulerIO = (delay: number, label: string): number => {
    let id = 0;
    id = scheduler.scheduleIO(delay, label, schedulerHandler(() => id));
    return id;
  };

  const modelOnDeliver = (id: number): void => {
    const plan = planFor(id);
    if (plan.spawnMicro) {
      model.schedule(model.now(), 'microtask', `m<-${id}`);
    }
    if (plan.spawnIoDelay >= 0) {
      model.schedule(model.now() + plan.spawnIoDelay, 'io', `io<-${id}`);
    }
    if (plan.cancelOffset > 0) {
      model.cancel(id + plan.cancelOffset);
    }
  };

  const compareTraces = (step: number): void => {
    assert.deepEqual(scheduler.trace(), model.delivered, `trace mismatch at step ${step}`);
    assert.equal(scheduler.pendingCount(), model.pending(), `pending mismatch at step ${step}`);
  };

  let maxId = 0;
  for (let step = 0; step < 400; step += 1) {
    const op = randInt(10);
    if (op < 4) {
      const delay = randInt(8);
      const label = `io-${step}`;
      const schedulerId = spawnSchedulerIO(delay, label);
      const modelId = model.schedule(model.now() + delay, 'io', label);
      assert.equal(schedulerId, modelId);
      maxId = schedulerId;
    } else if (op < 6) {
      const label = `micro-${step}`;
      const schedulerId = spawnSchedulerMicrotask(label);
      const modelId = model.schedule(model.now(), 'microtask', label);
      assert.equal(schedulerId, modelId);
      maxId = schedulerId;
    } else if (op < 8 && maxId > 0) {
      const target = 1 + randInt(maxId);
      assert.equal(scheduler.cancel(target), model.cancel(target), `cancel mismatch at step ${step}`);
    } else if (op < 9) {
      const delta = randInt(5);
      const budget = randInt(3) === 0 ? randInt(4) : Number.POSITIVE_INFINITY;
      const actual = scheduler.tick(delta, budget);
      const expected = model.advanceTo(model.now() + delta, budget, modelOnDeliver);
      assert.deepEqual(actual, expected, `run result mismatch at step ${step}`);
      compareTraces(step);
    } else {
      const budget = randInt(2) === 0 ? randInt(3) : Number.POSITIVE_INFINITY;
      const actual = scheduler.resume(budget);
      const expected = model.resume(budget, modelOnDeliver);
      assert.deepEqual(actual, expected, `resume result mismatch at step ${step}`);
      compareTraces(step);
    }
  }

  while (scheduler.pendingCount() > 0 || model.pending() > 0) {
    const actual = scheduler.tick(3);
    const expected = model.advanceTo(model.now() + 3, Number.POSITIVE_INFINITY, modelOnDeliver);
    assert.deepEqual(actual, expected, 'drain mismatch');
  }
  compareTraces(-1);
  assert.equal(scheduler.pendingCount(), 0);
});
