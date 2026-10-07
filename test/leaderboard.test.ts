import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AlreadyRevokedError,
  DuplicateEventError,
  InvalidEventError,
  Leaderboard,
  LedgerMismatchError,
  UnknownEventError,
  compareUtf8,
  diffTopK,
} from "../src/leaderboard";

describe("score accumulation", () => {
  it("sums integer deltas per user", () => {
    const lb = new Leaderboard(3);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.apply({ id: "e2", username: "alice", delta: 7 });
    lb.apply({ id: "e3", username: "bob", delta: 3 });
    assert.equal(lb.scoreOf("alice"), 12);
    assert.equal(lb.scoreOf("bob"), 3);
    assert.equal(lb.scoreOf("carol"), 0);
    lb.verify();
  });

  it("supports negative scores and negative deltas", () => {
    const lb = new Leaderboard(5);
    lb.apply({ id: "e1", username: "alice", delta: -4 });
    lb.apply({ id: "e2", username: "bob", delta: 2 });
    lb.apply({ id: "e3", username: "bob", delta: -9 });
    assert.equal(lb.scoreOf("alice"), -4);
    assert.equal(lb.scoreOf("bob"), -7);
    const top = lb.topK();
    assert.deepEqual(
      top.map((e) => [e.rank, e.username, e.score]),
      [
        [1, "alice", -4],
        [2, "bob", -7],
      ],
    );
    lb.verify();
  });

  it("drops users whose score returns to zero", () => {
    const lb = new Leaderboard(5);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.apply({ id: "e2", username: "alice", delta: -5 });
    assert.equal(lb.scoreOf("alice"), 0);
    assert.equal(lb.size, 0);
    assert.deepEqual(lb.topK(), []);
    lb.verify();
  });
});

describe("event identity", () => {
  it("treats an exact duplicate apply as an idempotent no-op", () => {
    const lb = new Leaderboard(3);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    const diff = lb.apply({ id: "e1", username: "alice", delta: 5 });
    assert.equal(lb.scoreOf("alice"), 5);
    assert.deepEqual(diff, { entered: [], left: [], changed: [] });
    lb.verify();
  });

  it("rejects the same id with different content", () => {
    const lb = new Leaderboard(3);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    assert.throws(
      () => lb.apply({ id: "e1", username: "alice", delta: 6 }),
      DuplicateEventError,
    );
    assert.throws(
      () => lb.apply({ id: "e1", username: "bob", delta: 5 }),
      DuplicateEventError,
    );
    assert.equal(lb.scoreOf("alice"), 5);
    assert.equal(lb.scoreOf("bob"), 0);
    lb.verify();
  });

  it("rejects non-integer deltas and bad fields", () => {
    const lb = new Leaderboard(3);
    assert.throws(
      () => lb.apply({ id: "e1", username: "alice", delta: 1.5 }),
      InvalidEventError,
    );
    assert.throws(
      () => lb.apply({ id: "e1", username: "alice", delta: Number.NaN }),
      InvalidEventError,
    );
    assert.throws(
      () => lb.apply({ id: "", username: "alice", delta: 1 }),
      InvalidEventError,
    );
    assert.throws(
      () => lb.apply({ id: "e1", username: "", delta: 1 }),
      InvalidEventError,
    );
    assert.throws(() => new Leaderboard(0), InvalidEventError);
  });
});

describe("revocation", () => {
  it("revokes an event exactly once", () => {
    const lb = new Leaderboard(3);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.apply({ id: "e2", username: "alice", delta: 3 });
    lb.revoke("e1");
    assert.equal(lb.scoreOf("alice"), 3);
    assert.throws(() => lb.revoke("e1"), AlreadyRevokedError);
    assert.equal(lb.scoreOf("alice"), 3);
    lb.verify();
  });

  it("rejects revoking an unknown id", () => {
    const lb = new Leaderboard(3);
    assert.throws(() => lb.revoke("nope"), UnknownEventError);
  });

  it("keeps a revoked id revoked when the same event is replayed", () => {
    const lb = new Leaderboard(3);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.revoke("e1");
    const diff = lb.apply({ id: "e1", username: "alice", delta: 5 });
    assert.deepEqual(diff, { entered: [], left: [], changed: [] });
    assert.equal(lb.scoreOf("alice"), 0);
    assert.throws(() => lb.revoke("e1"), AlreadyRevokedError);
    lb.verify();
  });

  it("still rejects different content for a revoked id", () => {
    const lb = new Leaderboard(3);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.revoke("e1");
    assert.throws(
      () => lb.apply({ id: "e1", username: "alice", delta: 6 }),
      DuplicateEventError,
    );
    lb.verify();
  });
});

describe("ranking order", () => {
  it("orders by score desc, then username in UTF-8 byte order", () => {
    const lb = new Leaderboard(10);
    // All tied at score 10; UTF-8 byte order:
    // "Zoe" (5A) < "alice" (61) < "zoe" (7A) < "éclair" (C3A9) < "中文" (E4B8AD)
    for (const [i, name] of ["中文", "éclair", "zoe", "alice", "Zoe"].entries()) {
      lb.apply({ id: `e${i}`, username: name, delta: 10 });
    }
    lb.apply({ id: "top", username: "bob", delta: 11 });
    lb.apply({ id: "low", username: "amy", delta: -1 });
    assert.deepEqual(
      lb.topK().map((e) => [e.rank, e.username, e.score]),
      [
        [1, "bob", 11],
        [2, "Zoe", 10],
        [3, "alice", 10],
        [4, "zoe", 10],
        [5, "éclair", 10],
        [6, "中文", 10],
        [7, "amy", -1],
      ],
    );
    lb.verify();
  });

  it("compareUtf8 follows UTF-8 byte order, not UTF-16 code units", () => {
    // U+FFFF (UTF-16: FFFF) vs U+10000 (UTF-16 surrogate pair D800 DC00):
    // UTF-16 order would put U+10000 first; UTF-8 bytes put U+FFFF (EF BF BF)
    // before U+10000 (F0 90 80 80).
    assert.ok(compareUtf8("￿", "𐀀") < 0);
    assert.ok(compareUtf8("a", "a") === 0);
    assert.ok(compareUtf8("apple", "banana") < 0);
  });

  it("limits the window to k entries", () => {
    const lb = new Leaderboard(2);
    lb.apply({ id: "e1", username: "a", delta: 1 });
    lb.apply({ id: "e2", username: "b", delta: 2 });
    lb.apply({ id: "e3", username: "c", delta: 3 });
    assert.deepEqual(
      lb.topK().map((e) => e.username),
      ["c", "b"],
    );
    assert.deepEqual(
      lb.topK(3).map((e) => e.username),
      ["c", "b", "a"],
    );
    lb.verify();
  });
});

describe("TopK net changes", () => {
  it("reports entered on first apply", () => {
    const lb = new Leaderboard(2);
    const diff = lb.apply({ id: "e1", username: "alice", delta: 5 });
    assert.deepEqual(diff.entered, [{ rank: 1, username: "alice", score: 5 }]);
    assert.deepEqual(diff.left, []);
    assert.deepEqual(diff.changed, []);
  });

  it("reports rank/score changes for users staying in the window", () => {
    const lb = new Leaderboard(2);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.apply({ id: "e2", username: "bob", delta: 3 });
    const diff = lb.apply({ id: "e3", username: "bob", delta: 4 });
    assert.deepEqual(diff.entered, []);
    assert.deepEqual(diff.left, []);
    assert.deepEqual(diff.changed, [
      { username: "bob", from: { rank: 2, score: 3 }, to: { rank: 1, score: 7 } },
      { username: "alice", from: { rank: 1, score: 5 }, to: { rank: 2, score: 5 } },
    ]);
  });

  it("reports left and entered when the window rotates", () => {
    const lb = new Leaderboard(2);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.apply({ id: "e2", username: "bob", delta: 3 });
    const diff = lb.apply({ id: "e3", username: "carol", delta: 9 });
    assert.deepEqual(diff.entered, [{ rank: 1, username: "carol", score: 9 }]);
    assert.deepEqual(diff.left, [{ rank: 2, username: "bob", score: 3 }]);
    assert.deepEqual(diff.changed, [
      { username: "alice", from: { rank: 1, score: 5 }, to: { rank: 2, score: 5 } },
    ]);
  });

  it("reports changes caused by revocation", () => {
    const lb = new Leaderboard(2);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    lb.apply({ id: "e2", username: "bob", delta: 3 });
    lb.apply({ id: "e3", username: "carol", delta: 1 });
    const diff = lb.revoke("e1");
    assert.deepEqual(diff.left, [{ rank: 1, username: "alice", score: 5 }]);
    assert.deepEqual(diff.entered, [{ rank: 2, username: "carol", score: 1 }]);
    assert.deepEqual(diff.changed, [
      { username: "bob", from: { rank: 2, score: 3 }, to: { rank: 1, score: 3 } },
    ]);
    lb.verify();
  });

  it("diffTopK is a pure function over snapshots", () => {
    const diff = diffTopK(
      [{ rank: 1, username: "a", score: 1 }],
      [{ rank: 1, username: "b", score: 2 }],
    );
    assert.deepEqual(diff.entered, [{ rank: 1, username: "b", score: 2 }]);
    assert.deepEqual(diff.left, [{ rank: 1, username: "a", score: 1 }]);
    assert.deepEqual(diff.changed, []);
  });
});

describe("full-ledger verification", () => {
  it("recomputes negative scores and ties from the ledger", () => {
    const lb = new Leaderboard(4);
    lb.apply({ id: "e1", username: "alice", delta: -10 });
    lb.apply({ id: "e2", username: "bob", delta: -10 });
    lb.apply({ id: "e3", username: "carol", delta: -10 });
    lb.apply({ id: "e4", username: "alice", delta: 4 });
    lb.revoke("e4");
    const ranking = lb.verify();
    assert.deepEqual(
      ranking.map((e) => [e.rank, e.username, e.score]),
      [
        [1, "alice", -10],
        [2, "bob", -10],
        [3, "carol", -10],
      ],
    );
  });

  it("stays consistent with the ledger across a deterministic fuzz run", () => {
    // Small deterministic PRNG (mulberry32).
    let state = 0x2f6e2b1;
    const rand = (): number => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const lb = new Leaderboard(7);
    const users = ["alice", "bob", "carol", "dave", "erin", "中文", "éclair", "Zoe"];
    const liveIds: string[] = [];
    let seq = 0;

    for (let step = 0; step < 500; step++) {
      const roll = rand();
      if (roll < 0.7 || liveIds.length === 0) {
        const username = users[Math.floor(rand() * users.length)] as string;
        const delta = Math.floor(rand() * 41) - 20; // -20..20, negatives included
        const id = `ev-${seq++}`;
        lb.apply({ id, username, delta });
        liveIds.push(id);
      } else {
        const index = Math.floor(rand() * liveIds.length);
        const id = liveIds.splice(index, 1)[0] as string;
        lb.revoke(id);
      }
      lb.verify(); // full-ledger recompute after every mutation
    }
  });

  it("detects divergence between incremental state and the ledger", () => {
    const lb = new Leaderboard(2);
    lb.apply({ id: "e1", username: "alice", delta: 5 });
    // Corrupt the incremental state behind the library's back.
    (lb as unknown as { scores: Map<string, number> }).scores.set("alice", 999);
    assert.throws(() => lb.verify(), LedgerMismatchError);
  });
});
