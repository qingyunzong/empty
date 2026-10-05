import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertEvent } from '../src/model.js';
import { mulberry32 } from '../src/rng.js';
import { AlertWindowStore } from '../src/store.js';
import { referenceDisplay } from './helpers.js';

test('窗口左端含右端不含，同时间按 ID 小者显示', () => {
  const s = new AlertWindowStore(10, 20);
  s.addEvent({ id: 1, key: 'a', ts: 10 }); // 左端：含
  s.addEvent({ id: 2, key: 'a', ts: 20 }); // 右端：不含
  s.addEvent({ id: 5, key: 'b', ts: 15 });
  s.addEvent({ id: 3, key: 'b', ts: 15 }); // 同时间按 ID：3 < 5
  s.addEvent({ id: 4, key: 'c', ts: 9 }); // 窗外
  assert.deepEqual(s.displayedItems(), [
    { key: 'a', eventId: 1, ts: 10 },
    { key: 'b', eventId: 3, ts: 15 },
  ]);
});

test('最早者删除后次早接替，删非显示项不影响显示集', () => {
  const s = new AlertWindowStore(0, 100);
  s.addEvent({ id: 1, key: 'a', ts: 5 });
  s.addEvent({ id: 2, key: 'a', ts: 7 });
  s.addEvent({ id: 3, key: 'a', ts: 9 });

  let cs = s.deleteEarliest('a');
  assert.deepEqual(cs.removes, [{ key: 'a', eventId: 1, ts: 5 }]);
  assert.deepEqual(cs.adds, [{ key: 'a', eventId: 2, ts: 7 }]);

  cs = s.deleteEvent(3); // 非显示项
  assert.deepEqual(cs.adds, []);
  assert.deepEqual(cs.removes, []);
  assert.deepEqual(s.displayedItems(), [{ key: 'a', eventId: 2, ts: 7 }]);

  cs = s.deleteEvent(2); // 显示项删尽
  assert.deepEqual(cs.removes, [{ key: 'a', eventId: 2, ts: 7 }]);
  assert.deepEqual(s.displayedItems(), []);
});

test('全局删除最早事件按 (ts, id) 取全窗最小显示项', () => {
  const s = new AlertWindowStore(0, 100);
  s.addEvent({ id: 1, key: 'a', ts: 5 });
  s.addEvent({ id: 2, key: 'b', ts: 5 }); // 同 ts，id 1 更早
  s.addEvent({ id: 3, key: 'c', ts: 3 });
  let cs = s.deleteEarliest();
  assert.deepEqual(cs.removes, [{ key: 'c', eventId: 3, ts: 3 }]);
  cs = s.deleteEarliest();
  assert.deepEqual(cs.removes, [{ key: 'a', eventId: 1, ts: 5 }]);
  assert.deepEqual(s.displayedItems(), [{ key: 'b', eventId: 2, ts: 5 }]);
});

test('窗移动产生净增删且版本连续递增', () => {
  const s = new AlertWindowStore(0, 10);
  s.addEvent({ id: 1, key: 'a', ts: 5 });
  s.addEvent({ id: 2, key: 'b', ts: 15 });
  const cs = s.moveWindow(10, 20);
  assert.equal(cs.version, 3);
  assert.deepEqual(cs.removes, [{ key: 'a', eventId: 1, ts: 5 }]);
  assert.deepEqual(cs.adds, [{ key: 'b', eventId: 2, ts: 15 }]);
  assert.deepEqual(s.history.map((h) => h.version), [1, 2, 3]);
  assert.throws(() => s.moveWindow(20, 10));
});

test('随机乱序插入/删除/移窗 vs 全排序扫描对照（多种子）', () => {
  const keys = ['k1', 'k2', 'k3', 'k4'];
  for (let seed = 1; seed <= 30; seed++) {
    const rand = mulberry32(seed);
    const s = new AlertWindowStore(0, 0);
    const alive = new Map<number, AlertEvent>();
    const pending: AlertEvent[] = [];
    for (let i = 0; i < 40; i++) {
      pending.push({
        id: i + 1,
        key: keys[Math.floor(rand() * keys.length)],
        ts: Math.floor(rand() * 30), // 刻意制造同时间冲突
      });
    }
    // Fisher-Yates 乱序
    for (let i = pending.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pending[i], pending[j]] = [pending[j], pending[i]];
    }
    let win = { start: 0, end: 0 };
    for (let op = 0; op < 80; op++) {
      const r = rand();
      if (r < 0.4 && pending.length > 0) {
        const e = pending.pop()!;
        alive.set(e.id, e);
        s.addEvent(e);
      } else if (r < 0.7 && alive.size > 0) {
        const ids = [...alive.keys()];
        const id = ids[Math.floor(rand() * ids.length)];
        alive.delete(id);
        s.deleteEvent(id);
      } else {
        const start = Math.floor(rand() * 31);
        const end = start + Math.floor(rand() * 8); // 允许空窗
        win = { start, end };
        s.moveWindow(start, end);
      }
      assert.deepEqual(
        s.displayedItems(),
        referenceDisplay([...alive.values()], win.start, win.end),
        `seed=${seed} op=${op}`,
      );
    }
    // 乱序插入与全排序插入殊途同归
    const sorted = new AlertWindowStore(win.start, win.end);
    for (const e of [...alive.values()].sort((a, b) => a.ts - b.ts || a.id - b.id)) {
      sorted.addEvent(e);
    }
    assert.deepEqual(s.displayedItems(), sorted.displayedItems(), `seed=${seed} sorted`);
  }
});
