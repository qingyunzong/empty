import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SessionStore,
  type Session,
  type SessionEvent,
  type SessionOp,
} from "../src/session-store.js";

const GAP = 30_000; // 30s

function ev(id: string, userId: string, timestamp: number): SessionEvent {
  return { id, userId, timestamp };
}

function summarize(sessions: Session[]): string[] {
  return sessions.map(
    (s) => `${s.userId}:${s.id}[${s.start}..${s.end}]x${s.count}`,
  );
}

describe("session 归一（相邻间距 <= gap）", () => {
  it("同用户相邻事件间距不超过 gap 归为一个会话，ID 取成员最小 ID", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e3", "u1", 20_000) },
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
      { type: "add", event: ev("e9", "u1", 100_000) }, // 间距 80s > gap，独立会话
    ]);
    const sessions = store.sessions();
    assert.equal(sessions.length, 2);
    assert.deepEqual(summarize(sessions), [
      "u1:e1[0..20000]x3",
      "u1:e9[100000..100000]x1",
    ]);
    assert.equal(sessions[0]!.id, "e1"); // 成员最小 ID
    store.verify();
  });

  it("不同用户互不影响", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("a1", "u1", 0) },
      { type: "add", event: ev("b1", "u2", 5_000) },
      { type: "add", event: ev("a2", "u1", 10_000) },
    ]);
    assert.deepEqual(summarize(store.sessions()), [
      "u1:a1[0..10000]x2",
      "u2:b1[5000..5000]x1",
    ]);
    store.verify();
  });
});

describe("删除中间事件导致分裂", () => {
  it("删除桥接事件后分裂为两个会话，各自取最小成员 ID", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 20_000) }, // 桥接事件
      { type: "add", event: ev("e3", "u1", 45_000) }, // e1..e3 间距 45s > gap
    ]);
    assert.equal(store.sessions().length, 1);
    store.removeEvent("e2");
    const sessions = store.sessions();
    assert.deepEqual(summarize(sessions), [
      "u1:e1[0..0]x1",
      "u1:e3[45000..45000]x1",
    ]);
    store.verify();
  });

  it("删除不跨 gap 的事件不分裂", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
      { type: "add", event: ev("e3", "u1", 20_000) },
    ]);
    store.removeEvent("e2");
    assert.deepEqual(summarize(store.sessions()), ["u1:e1[0..20000]x2"]);
    store.verify();
  });
});

describe("更正时间导致合并", () => {
  it("把事件改到两个会话之间会将二者合并", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
      { type: "add", event: ev("e3", "u1", 50_000) },
      { type: "add", event: ev("e4", "u1", 60_000) },
      { type: "add", event: ev("e5", "u1", 500_000) }, // 远离的独立事件
    ]);
    assert.equal(store.sessions().length, 3);
    store.updateEventTime("e5", 30_000); // 桥接两个会话
    const sessions = store.sessions();
    assert.deepEqual(summarize(sessions), ["u1:e1[0..60000]x5"]);
    assert.equal(sessions[0]!.id, "e1");
    store.verify();
  });

  it("把事件改远会导致分裂", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
      { type: "add", event: ev("e3", "u1", 20_000) },
    ]);
    store.updateEventTime("e2", 200_000);
    assert.deepEqual(summarize(store.sessions()), [
      "u1:e1[0..20000]x2",
      "u1:e2[200000..200000]x1",
    ]);
    store.verify();
  });
});

describe("乱序增删后的净差分", () => {
  it("diff 报告 added/removed/changed，会话 ID 变化体现为 remove+add", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
      { type: "add", event: ev("f1", "u2", 0) },
    ]);
    store.commit();

    store.apply([
      { type: "remove", eventId: "e1" }, // u1 会话最小 ID 变为 e2
      { type: "add", event: ev("e3", "u1", 20_000) }, // 并入 u1 会话
      { type: "update", eventId: "f1", timestamp: 5_000 }, // u2 会话时间变化
      { type: "add", event: ev("g1", "u3", 0) }, // 新用户新会话
    ]);

    const diff = store.diff();
    assert.deepEqual(summarize(diff.added), [
      "u1:e2[10000..20000]x2",
      "u3:g1[0..0]x1",
    ]);
    assert.deepEqual(summarize(diff.removed), ["u1:e1[0..10000]x2"]);
    assert.equal(diff.changed.length, 1);
    assert.deepEqual(diff.changed[0]!.before.memberIds, ["f1"]);
    assert.equal(diff.changed[0]!.before.start, 0);
    assert.equal(diff.changed[0]!.after.start, 5_000);
    store.verify();
  });

  it("净差分与基线叠加后等于当前状态", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
    ]);
    store.commit();
    store.apply([
      { type: "remove", eventId: "e1" },
      { type: "add", event: ev("e3", "u1", 100_000) },
    ]);
    const diff = store.diff();
    // 对基线应用差分
    const result = new Map<string, Session>();
    // 基线会话（重放）
    const replay = new SessionStore(GAP);
    replay.apply([
      { type: "add", event: ev("e1", "u1", 0) },
      { type: "add", event: ev("e2", "u1", 10_000) },
    ]);
    for (const s of replay.sessions()) result.set(s.userId + s.id, s);
    for (const s of diff.removed) result.delete(s.userId + s.id);
    for (const s of diff.added) result.set(s.userId + s.id, s);
    for (const c of diff.changed) result.set(c.after.userId + c.after.id, c.after);
    assert.deepEqual(
      [...result.values()].map((s) => JSON.stringify(s)).sort(),
      store.sessions().map((s) => JSON.stringify(s)).sort(),
    );
  });
});

describe("随机乱序操作与排序重建核对", () => {
  // 简单可复现的 PRNG
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 7, 42, 1337, 20261005]) {
    it(`seed=${seed}：增量结果始终等于排序重建`, () => {
      const rand = mulberry32(seed);
      const store = new SessionStore(GAP);
      const live = new Map<string, SessionEvent>();
      let counter = 0;

      for (let step = 0; step < 400; step++) {
        const ops: SessionOp[] = [];
        const batchSize = 1 + Math.floor(rand() * 5);
        for (let b = 0; b < batchSize; b++) {
          const roll = rand();
          if (roll < 0.5 || live.size === 0) {
            const event = ev(
              `e${counter++}`,
              `u${Math.floor(rand() * 4)}`,
              Math.floor(rand() * 200) * 10_000,
            );
            live.set(event.id, event);
            ops.push({ type: "add", event });
          } else if (roll < 0.75) {
            const ids = [...live.keys()];
            const id = ids[Math.floor(rand() * ids.length)]!;
            live.delete(id);
            ops.push({ type: "remove", eventId: id });
          } else {
            const ids = [...live.keys()];
            const id = ids[Math.floor(rand() * ids.length)]!;
            const timestamp = Math.floor(rand() * 200) * 10_000;
            live.set(id, { ...live.get(id)!, timestamp });
            ops.push({ type: "update", eventId: id, timestamp });
          }
        }
        store.apply(ops);
        store.verify();
        // 与独立参考实现核对（基于当前存活事件集合）
        assert.deepEqual(
          store.sessions(),
          SessionStore.rebuildSessions(live.values(), GAP),
        );
      }
    });
  }

  it("差分核对：diff 与两端各自重建的差一致", () => {
    const rand = mulberry32(99);
    const store = new SessionStore(GAP);
    const live = new Map<string, SessionEvent>();
    let counter = 0;
    const randomBatch = (): SessionOp[] => {
      const ops: SessionOp[] = [];
      for (let b = 0; b < 1 + Math.floor(rand() * 6); b++) {
        const roll = rand();
        if (roll < 0.5 || live.size === 0) {
          const event = ev(
            `e${counter++}`,
            `u${Math.floor(rand() * 3)}`,
            Math.floor(rand() * 100) * 10_000,
          );
          live.set(event.id, event);
          ops.push({ type: "add", event });
        } else if (roll < 0.8) {
          const ids = [...live.keys()];
          const id = ids[Math.floor(rand() * ids.length)]!;
          live.delete(id);
          ops.push({ type: "remove", eventId: id });
        } else {
          const ids = [...live.keys()];
          const id = ids[Math.floor(rand() * ids.length)]!;
          const timestamp = Math.floor(rand() * 100) * 10_000;
          live.set(id, { ...live.get(id)!, timestamp });
          ops.push({ type: "update", eventId: id, timestamp });
        }
      }
      return ops;
    };

    for (let round = 0; round < 30; round++) {
      store.apply(randomBatch());
      store.verify();
      const before = new Map(
        store.rebuild().map((s) => [s.userId + "|" + s.id, JSON.stringify(s)]),
      );
      store.commit();
      store.apply(randomBatch());
      store.verify();
      const after = new Map(
        store.rebuild().map((s) => [s.userId + "|" + s.id, JSON.stringify(s)]),
      );
      const diff = store.diff();
      // 用重建结果独立计算期望差分
      const expectAdded = [...after.keys()].filter((k) => !before.has(k)).sort();
      const expectRemoved = [...before.keys()].filter((k) => !after.has(k)).sort();
      const expectChanged = [...after.keys()]
        .filter((k) => before.has(k) && before.get(k) !== after.get(k))
        .sort();
      assert.deepEqual(
        diff.added.map((s) => s.userId + "|" + s.id).sort(),
        expectAdded,
      );
      assert.deepEqual(
        diff.removed.map((s) => s.userId + "|" + s.id).sort(),
        expectRemoved,
      );
      assert.deepEqual(
        diff.changed.map((c) => c.after.userId + "|" + c.after.id).sort(),
        expectChanged,
      );
    }
  });
});

describe("边界与错误处理", () => {
  it("重复 ID / 未知 ID 抛错", () => {
    const store = new SessionStore(GAP);
    store.addEvent(ev("e1", "u1", 0));
    assert.throws(() => store.addEvent(ev("e1", "u1", 1)));
    assert.throws(() => store.removeEvent("nope"));
    assert.throws(() => store.updateEventTime("nope", 0));
  });

  it("相同时间戳事件按 ID 排序且间距为 0 可归并", () => {
    const store = new SessionStore(GAP);
    store.apply([
      { type: "add", event: ev("b", "u1", 1000) },
      { type: "add", event: ev("a", "u1", 1000) },
    ]);
    const sessions = store.sessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.memberIds, ["a", "b"]);
    assert.equal(sessions[0]!.id, "a");
    store.verify();
  });

  it("删空后用户会话消失", () => {
    const store = new SessionStore(GAP);
    store.addEvent(ev("e1", "u1", 0));
    store.removeEvent("e1");
    assert.deepEqual(store.sessions(), []);
    store.verify();
  });
});
