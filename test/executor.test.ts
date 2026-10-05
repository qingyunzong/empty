import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor, Task } from '../src/executor.js';
import { AlertEvent, ChangeSet } from '../src/model.js';
import { mulberry32 } from '../src/rng.js';
import { AlertWindowStore } from '../src/store.js';
import { SubscriberMessage } from '../src/subscription.js';
import { reconstruct, referenceDisplay } from './helpers.js';

function subscriberMessages(outputs: (ChangeSet | SubscriberMessage[])[]): SubscriberMessage[] {
  const msgs: SubscriberMessage[] = [];
  for (const o of outputs) if (Array.isArray(o)) msgs.push(...o);
  return msgs;
}

test('可控执行器交错删最早/移窗/快照，版本连续且来源可核对', () => {
  const s = new AlertWindowStore(0, 10);
  const sub = s.subscribe();
  const ex = new Executor(s);
  ex.enqueue(
    { type: 'add', event: { id: 1, key: 'a', ts: 1 } },
    { type: 'add', event: { id: 2, key: 'a', ts: 2 } },
    { type: 'add', event: { id: 3, key: 'b', ts: 3 } },
    { type: 'snapshot' },
    { type: 'deleteEarliest' }, // 删全窗最早 a:1 → a:2 接替
    { type: 'moveWindow', start: 2, end: 10 },
    { type: 'deleteEarliest', key: 'b' },
    { type: 'moveWindow', start: 0, end: 2 },
    { type: 'poll', subscriptionId: sub.id },
  );
  ex.runAll();

  // 版本连续：每个变更批次恰好 +1
  const versions = ex.log.filter((l) => l.version !== undefined).map((l) => l.version!);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7]);
  // 来源与入队任务一一对应
  const sources = ex.log.filter((l) => l.source !== undefined).map((l) => l.source!);
  assert.deepEqual(sources, [
    'add',
    'add',
    'add',
    'deleteEarliest',
    'moveWindow',
    'deleteEarliest',
    'moveWindow',
  ]);
  // 任务日志顺序完整（含快照与 poll）
  assert.deepEqual(
    ex.log.map((l) => l.task),
    ['add', 'add', 'add', 'snapshot', 'deleteEarliest', 'moveWindow', 'deleteEarliest', 'moveWindow', 'poll'],
  );

  // 订阅流重建：快照 v0 → 净变化 v3 → v4..v7 连续
  const msgs = subscriberMessages(ex.outputs);
  const { state, versions: subVersions } = reconstruct(msgs);
  assert.deepEqual(subVersions, [0, 3, 4, 5, 6, 7]);
  assert.deepEqual(state, s.displayedItems());
  assert.deepEqual(state, referenceDisplay([{ id: 2, key: 'a', ts: 2 }], 0, 2));
  assert.deepEqual(state, []); // a:2 的 ts=2 不在 [0,2) 内（右端不含）
});

test('随机交错执行（种子乱序）后显示集、订阅重建与参照一致，版本连续', () => {
  const keys = ['k1', 'k2', 'k3'];
  for (let seed = 1; seed <= 15; seed++) {
    const rand = mulberry32(seed);
    const s = new AlertWindowStore(0, 1);
    const sub = s.subscribe(1000);
    const ex = new Executor(s);
    let nextId = 1;
    const tasks: Task[] = [];
    for (let op = 0; op < 60; op++) {
      const r = rand();
      if (r < 0.45) {
        const e: AlertEvent = {
          id: nextId++,
          key: keys[Math.floor(rand() * keys.length)],
          ts: Math.floor(rand() * 25),
        };
        tasks.push({ type: 'add', event: e });
      } else if (r < 0.7) {
        // deleteEarliest 对空窗/空集安全，乱序执行不失效
        const key = rand() < 0.5 ? keys[Math.floor(rand() * keys.length)] : undefined;
        tasks.push({ type: 'deleteEarliest', key });
      } else if (r < 0.9) {
        const start = Math.floor(rand() * 26);
        const end = start + Math.floor(rand() * 6);
        tasks.push({ type: 'moveWindow', start, end });
      } else {
        tasks.push({ type: 'poll', subscriptionId: sub.id });
      }
    }
    tasks.push({ type: 'snapshot' }); // 快照发布时机也参与交错
    ex.enqueue(...tasks);
    ex.runShuffled(rand);

    // 版本连续：1..M 每批 +1
    const versions = ex.log.filter((l) => l.version !== undefined).map((l) => l.version!);
    assert.deepEqual(versions, versions.map((_, i) => i + 1), `seed=${seed} versions`);
    // 来源均来自入队的变更任务类型
    for (const l of ex.log) {
      if (l.source) assert.equal(l.source, l.task, `seed=${seed} source`);
    }

    // 显示集与全排序扫描参照一致
    const w = s.window;
    assert.deepEqual(
      s.displayedItems(),
      referenceDisplay(s.remainingEvents(), w.start, w.end),
      `seed=${seed} reference`,
    );
    // 订阅重建（含快照与所有 poll 的消息流）与显示集一致
    const msgs = subscriberMessages(ex.outputs);
    const tail = sub.poll(); // 收尾取净剩余
    const { state } = reconstruct([...msgs, ...tail]);
    assert.deepEqual(state, s.displayedItems(), `seed=${seed} rebuild`);
  }
});
