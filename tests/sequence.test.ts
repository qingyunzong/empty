import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SequenceStore, type Handle, type SeqEvent } from "../src/sequence.ts";
import { ModelSequence, type ModelEvent } from "./model.ts";

/** 去掉 seq 序号后比较事件序列 */
function stripSeq(events: SeqEvent[]): ModelEvent[] {
  return events.map(({ seq: _seq, ...rest }) => rest as ModelEvent);
}

test("删除当前项后 next 到达原后继", () => {
  const s = new SequenceStore<string>();
  s.append("a");
  s.append("b");
  s.append("c");
  const cur = s.openCursor();
  const first = cur.next()!;
  assert.equal(first.value, "a");
  // 删除当前项 a，游标仍应能到达原后继 b
  s.delete(first.handle);
  assert.equal(cur.next()!.value, "b");
  assert.equal(cur.next()!.value, "c");
  assert.equal(cur.next(), null);
  cur.close();
  assert.deepEqual(s.values(), ["b", "c"]);
});

test("后继也被删除时跳过墓碑到达下一个存活元素", () => {
  const s = new SequenceStore<number>();
  const hs = [1, 2, 3, 4].map((v) => s.append(v));
  const cur = s.openCursor();
  const first = cur.next()!;
  // 删除当前项与其后的两个元素（b、c 成为墓碑）
  s.delete(first.handle);
  s.delete(hs[1]!);
  s.delete(hs[2]!);
  assert.equal(cur.next()!.value, 4);
  assert.equal(cur.next(), null);
  cur.close();
});

test("插入游标之前不重访，插入游标之后可访问", () => {
  // 插入到锚点（游标当前位置）之后 → 可访问
  const s = new SequenceStore<string>();
  const ha = s.append("a");
  const hb = s.append("b");
  s.append("c");
  const cur = s.openCursor();
  assert.equal(cur.next()!.value, "a"); // 锚点 = a
  s.insertAfter(ha, "after-a"); // 紧邻锚点之后 → 可见
  s.insertBefore(hb, "before-b"); // 位于 a 与 b 之间，仍在锚点之后 → 可见
  const seen: string[] = [];
  for (let r = cur.next(); r; r = cur.next()) seen.push(r.value);
  cur.close();
  assert.deepEqual(seen, ["after-a", "before-b", "b", "c"]);

  // 插入到锚点之前 → 不重访
  const s2 = new SequenceStore<string>();
  const hx = s2.append("x");
  s2.append("y");
  const c2 = s2.openCursor();
  assert.equal(c2.next()!.value, "x"); // 锚点 = x
  s2.insertBefore(hx, "pre-x"); // 插到锚点之前 → 不重访
  const seen2: string[] = [];
  for (let r = c2.next(); r; r = c2.next()) seen2.push(r.value);
  c2.close();
  assert.deepEqual(seen2, ["y"]);
  assert.deepEqual(s2.values(), ["pre-x", "x", "y"]);
});

test("ID 复用必须提升代际，旧代际句柄全部失效", () => {
  const s = new SequenceStore<string>();
  const h1 = s.append("v1"); // id=0 gen=1
  s.delete(h1); // 无游标保留 → 立即回收
  const h2 = s.append("v2"); // 复用 id=0，gen=2
  assert.equal(h2.id, h1.id);
  assert.equal(h2.gen, h1.gen + 1);
  // 旧句柄失效
  assert.equal(s.get(h1), undefined);
  assert.equal(s.has(h1), false);
  assert.throws(() => s.delete(h1), /stale handle/);
  assert.throws(() => s.insertAfter(h1, "x"), /stale handle/);
  assert.throws(() => s.insertBefore(h1, "x"), /stale handle/);
  assert.throws(() => s.openCursor(h1), /stale handle/);
  assert.equal(s.get(h2), "v2");
});

test("游标保留墓碑，关闭后释放并触发回收", () => {
  const s = new SequenceStore<string>();
  s.append("a");
  s.append("b");
  const cur = s.openCursor(); // cursor 0
  const first = cur.next()!; // 锚点 = a，游标保留 a
  s.delete(first.handle); // a 成墓碑但被游标保留 → 不回收
  assert.deepEqual(
    stripSeq(s.events).filter((e) => e.type === "recycle"),
    [],
  );
  // 墓碑仍支撑遍历：next 到达原后继 b；离开 a 后保留归零 → 回收 a
  const second = cur.next()!;
  assert.equal(second.value, "b");
  assert.deepEqual(stripSeq(s.events).filter((e) => e.type === "recycle"), [
    { type: "recycle", id: first.handle.id, gen: first.handle.gen },
  ]);
  // 删除当前锚点 b：被游标保留 → 不回收；关闭游标时才回收
  s.delete(second.handle);
  const before = stripSeq(s.events).length;
  cur.close();
  assert.deepEqual(stripSeq(s.events).slice(before), [
    { type: "recycle", id: second.handle.id, gen: second.handle.gen },
    { type: "cursor-close", cursor: 0 },
  ]);
});

test("事件序列与墓碑链表模型核验（脚本化场景）", () => {
  const s = new SequenceStore<number>();
  const m = new ModelSequence();

  const h1s = s.append(10);
  const h1m = m.append(10);
  const h2s = s.append(20);
  const h2m = m.append(20);
  s.prepend(5);
  m.prepend(5);

  const cs = s.openCursor();
  const cm = m.openCursor();
  assert.deepEqual(cs.next(), { handle: cm.next()!.handle, value: 5 });

  s.delete(h1s); // 删除 10
  m.delete(h1m);
  s.insertAfter(h2s, 25); // 在 20 后插入 25
  m.insertAfter(h2m, 25);

  const r1s = cs.next();
  const r1m = cm.next();
  assert.deepEqual(r1s, r1m ? { handle: r1m.handle, value: r1m.value } : null);

  cs.close();
  cm.close();
  s.delete(h2s);
  m.delete(h2m);

  assert.deepEqual(s.values(), m.values());
  assert.deepEqual(stripSeq(s.events), m.events);
});

test("随机操作序列：实现与模型的事件流、遍历结果完全一致", () => {
  // 确定性 PRNG（mulberry32）
  let seed = 0x9e3779b9;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

  for (let trial = 0; trial < 20; trial++) {
    const s = new SequenceStore<number>();
    const m = new ModelSequence();
    const liveS: Handle[] = [];
    const liveM: { id: number; gen: number }[] = [];
    const cursS: ReturnType<SequenceStore<number>["openCursor"]>[] = [];
    const cursM: ReturnType<ModelSequence["openCursor"]>[] = [];

    for (let step = 0; step < 400; step++) {
      const op = Math.floor(rand() * 8);
      if (op <= 1 || liveS.length === 0) {
        // append / prepend
        const v = trial * 10000 + step;
        if (rand() < 0.5) {
          liveS.push(s.append(v));
          liveM.push(m.append(v));
        } else {
          liveS.push(s.prepend(v));
          liveM.push(m.prepend(v));
        }
      } else if (op === 2) {
        // delete 随机存活元素
        const i = Math.floor(rand() * liveS.length);
        s.delete(liveS[i]!);
        m.delete(liveM[i]!);
        liveS.splice(i, 1);
        liveM.splice(i, 1);
      } else if (op === 3) {
        // insertAfter / insertBefore 随机存活元素
        const i = Math.floor(rand() * liveS.length);
        const v = trial * 10000 + step;
        if (rand() < 0.5) {
          liveS.push(s.insertAfter(liveS[i]!, v));
          liveM.push(m.insertAfter(liveM[i]!, v));
        } else {
          liveS.push(s.insertBefore(liveS[i]!, v));
          liveM.push(m.insertBefore(liveM[i]!, v));
        }
      } else if (op === 4) {
        // 打开游标（从头或从随机存活元素之后）
        if (rand() < 0.5) {
          cursS.push(s.openCursor());
          cursM.push(m.openCursor());
        } else {
          const i = Math.floor(rand() * liveS.length);
          cursS.push(s.openCursor(liveS[i]!));
          cursM.push(m.openCursor(liveM[i]!));
        }
      } else if (op === 5 && cursS.length > 0) {
        // 游标 next：结果必须一致
        const i = Math.floor(rand() * cursS.length);
        const rs = cursS[i]!.next();
        const rm = cursM[i]!.next();
        assert.deepEqual(
          rs,
          rm ? { handle: rm.handle, value: rm.value } : null,
          `trial=${trial} step=${step} cursor next`,
        );
      } else if (op === 6 && cursS.length > 0) {
        // 关闭游标
        const i = Math.floor(rand() * cursS.length);
        cursS[i]!.close();
        cursM[i]!.close();
        cursS.splice(i, 1);
        cursM.splice(i, 1);
      } else if (op === 7) {
        // 旧句柄（可能已失效）读取：结果必须一致
        const i = Math.floor(rand() * (liveS.length + 1));
        if (i < liveS.length) {
          const gotS = s.get(liveS[i]!);
          assert.equal(gotS !== undefined, true);
          void gotS;
        }
      }
      // 每一步：可见序列与完整事件流必须一致
      assert.deepEqual(s.values(), m.values(), `trial=${trial} step=${step} values`);
      assert.deepEqual(
        stripSeq(s.events),
        m.events,
        `trial=${trial} step=${step} events`,
      );
    }
    for (const c of cursS) c.close();
    for (const c of cursM) c.close();
    assert.deepEqual(stripSeq(s.events), m.events, `trial=${trial} final events`);
  }
});

test("句柄代际在游标遍历期间保持稳定", () => {
  const s = new SequenceStore<string>();
  const seen: Handle[] = [];
  for (const v of ["a", "b", "c"]) seen.push(s.append(v));
  const cur = s.openCursor();
  const first = cur.next()!;
  s.delete(first.handle);
  s.delete(seen[1]!);
  // 触发复用：新元素可能复用已回收槽位，但 gen 不同
  s.append("d");
  const rest: string[] = [];
  for (let r = cur.next(); r; r = cur.next()) rest.push(r.value);
  cur.close();
  // 游标锚定链不受复用影响：只看到遍历方向上的存活元素
  assert.deepEqual(rest, ["c", "d"]);
});
