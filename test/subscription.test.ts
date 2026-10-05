import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertWindowStore } from '../src/store.js';
import { reconstruct } from './helpers.js';

test('首次快照期间更正缓冲，发布后净变化不含同批撤销的显示项', () => {
  const s = new AlertWindowStore(0, 100);
  s.addEvent({ id: 1, key: 'a', ts: 1 }); // v1
  const sub = s.subscribe();
  // 快照捕获后、发布前的更正：
  s.addEvent({ id: 2, key: 'b', ts: 2 }); // v2：b 增
  s.addEvent({ id: 3, key: 'c', ts: 3 }); // v3：c 增
  s.deleteEvent(3); // v4：c 撤销（同段缓冲内增了又删）
  s.addEvent({ id: 4, key: 'a', ts: 0 }); // v5：a 由 1 换 4

  const msgs = s.completeNextSnapshot()!;
  assert.equal(msgs[0].kind, 'snapshot');
  if (msgs[0].kind !== 'snapshot') return;
  assert.equal(msgs[0].version, 1);
  assert.deepEqual(msgs[0].items, [{ key: 'a', eventId: 1, ts: 1 }]);

  assert.equal(msgs.length, 2);
  const net = msgs[1];
  if (net.kind !== 'changes') throw new Error('expected net changes');
  assert.equal(net.changes.source, 'snapshot');
  assert.equal(net.changes.version, 5); // 折入到最后一笔缓冲版本
  // 被同批撤销的 c:3 不得出现在净变化里
  assert.ok(!net.changes.adds.some((i) => i.eventId === 3));
  assert.ok(!net.changes.removes.some((i) => i.eventId === 3));
  assert.deepEqual(net.changes.adds, [
    { key: 'a', eventId: 4, ts: 0 },
    { key: 'b', eventId: 2, ts: 2 },
  ]);
  assert.deepEqual(net.changes.removes, [{ key: 'a', eventId: 1, ts: 1 }]);

  // 重建状态 == 当前显示集；后续实时批次版本从 5 连续到 6
  s.addEvent({ id: 5, key: 'd', ts: 4 }); // v6
  const live = sub.poll();
  const { state, versions } = reconstruct([...msgs, ...live]);
  assert.deepEqual(state, s.displayedItems());
  assert.deepEqual(versions, [1, 5, 6]);
});

test('无更正时快照发布只含快照本身', () => {
  const s = new AlertWindowStore(0, 10);
  s.addEvent({ id: 1, key: 'a', ts: 1 });
  s.subscribe();
  const msgs = s.completeNextSnapshot()!;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'snapshot');
});

test('慢订阅积压超额转重同步，版本不丢且断点显式可见', () => {
  const s = new AlertWindowStore(0, 100);
  const sub = s.subscribe(2); // 容量 2
  s.completeNextSnapshot(); // 立即发布，无更正

  s.addEvent({ id: 1, key: 'a', ts: 1 }); // v1 入队
  s.addEvent({ id: 2, key: 'b', ts: 2 }); // v2 入队（满）
  s.addEvent({ id: 3, key: 'c', ts: 3 }); // v3 超额 → 转重同步
  s.addEvent({ id: 4, key: 'd', ts: 4 }); // v4 重同步等待期间直接覆盖

  const msgs = sub.poll();
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  if (m.kind !== 'resync') throw new Error('expected resync');
  assert.equal(m.version, s.currentVersion); // 跳到最新版本，不丢版本
  assert.equal(m.version, 4);
  assert.equal(m.lostFromVersion, 0); // 断点：订阅方连续知识止于 v0
  assert.deepEqual(m.items, s.displayedItems());

  // 重同步后恢复正常逐批投递，版本连续
  s.addEvent({ id: 5, key: 'e', ts: 5 }); // v5
  const after = sub.poll();
  assert.equal(after.length, 1);
  if (after[0].kind !== 'changes') throw new Error('expected changes');
  assert.equal(after[0].changes.version, 5);

  const { state, versions } = reconstruct([...msgs, ...after]);
  assert.deepEqual(state, s.displayedItems());
  assert.deepEqual(versions, [4, 5]);
});

test('容量内不触发重同步，按序收到全部批次', () => {
  const s = new AlertWindowStore(0, 100);
  const sub = s.subscribe(4);
  s.completeNextSnapshot();
  s.addEvent({ id: 1, key: 'a', ts: 1 });
  s.addEvent({ id: 2, key: 'b', ts: 2 });
  s.addEvent({ id: 3, key: 'c', ts: 3 });
  const msgs = sub.poll();
  assert.equal(msgs.length, 3);
  assert.ok(msgs.every((m) => m.kind === 'changes'));
  const { versions } = reconstruct(msgs);
  assert.deepEqual(versions, [1, 2, 3]);
});
