import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CrdtDocument,
  ROOT,
  makeId,
  insert,
  del,
  type Message,
} from "../src/crdt";

/** deterministic PRNG so fuzz runs are reproducible */
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

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

describe("sequential inserts", () => {
  test("chained predecessors build the text in order", () => {
    const doc = new CrdtDocument();
    const text = "hello";
    let pred = ROOT;
    for (let i = 0; i < text.length; i++) {
      const id = makeId("A", i);
      assert.equal(doc.apply(insert(id, pred, text[i] as string)), "applied");
      pred = id;
    }
    assert.equal(doc.projection(), "hello");
    assert.equal(doc.size, 5);
  });
});

describe("concurrent inserts at the same position", () => {
  test("siblings are ordered by id, replicas converge", () => {
    // shared prefix: char P
    const p = makeId("A", 0);
    // two sites concurrently insert right after P
    const b1 = insert(makeId("B", 1), p, "1");
    const c1 = insert(makeId("C", 1), p, "2");

    const r1 = new CrdtDocument();
    r1.apply(insert(p, ROOT, "P"));
    r1.apply(b1);
    r1.apply(c1);

    const r2 = new CrdtDocument();
    r2.apply(insert(p, ROOT, "P"));
    r2.apply(c1); // opposite delivery order
    r2.apply(b1);

    // higher id sorts first: C@000001 before B@000001
    assert.equal(r1.projection(), "P21");
    assert.equal(r2.projection(), "P21");
  });
});

describe("deletes and tombstones", () => {
  test("delete hides the char but keeps the node; inserts after it still work", () => {
    const doc = new CrdtDocument();
    const a = makeId("A", 0);
    const b = makeId("A", 1);
    const c = makeId("A", 2);
    doc.apply(insert(a, ROOT, "a"));
    doc.apply(insert(b, a, "b"));
    doc.apply(insert(c, b, "c"));
    assert.equal(doc.projection(), "abc");

    assert.equal(doc.apply(del(b)), "applied");
    assert.equal(doc.projection(), "ac");
    assert.equal(doc.size, 3); // tombstone retained
    assert.equal(doc.tombstoneCount, 1);
    assert.ok(doc.isDeleted(b));

    // insert after the tombstoned char: d lands between a and c
    doc.apply(insert(makeId("A", 3), b, "d"));
    assert.equal(doc.projection(), "adc");
  });

  test("delete arriving before its target is buffered, then applied", () => {
    const doc = new CrdtDocument();
    const x = makeId("A", 0);
    assert.equal(doc.apply(del(x)), "buffered");
    assert.equal(doc.apply(insert(x, ROOT, "x")), "applied");
    assert.equal(doc.projection(), ""); // immediately tombstoned
    assert.ok(doc.isDeleted(x));
  });
});

describe("out-of-order and duplicate delivery", () => {
  test("child before parent is buffered, never re-attached to root", () => {
    const doc = new CrdtDocument();
    const parent = makeId("A", 0);
    const child = makeId("A", 1);

    assert.equal(doc.apply(insert(child, parent, "c")), "buffered");
    assert.ok(doc.isBuffered(child));
    assert.equal(doc.projection(), ""); // not visible, not hung on ROOT

    assert.equal(doc.apply(insert(parent, ROOT, "p")), "applied");
    assert.equal(doc.bufferedCount, 0); // flushed
    assert.equal(doc.projection(), "pc");
  });

  test("duplicates are idempotent", () => {
    const doc = new CrdtDocument();
    const a = makeId("A", 0);
    const m = insert(a, ROOT, "a");
    assert.equal(doc.apply(m), "applied");
    assert.equal(doc.apply(m), "duplicate");
    assert.equal(doc.apply(m), "duplicate");
    assert.equal(doc.apply(del(a)), "applied");
    assert.equal(doc.apply(del(a)), "duplicate");
    assert.equal(doc.projection(), "");
    assert.equal(doc.size, 1);
  });
});

describe("malicious dependency cycles", () => {
  test("mutual cycle is detected and rejected, projection untouched", () => {
    const doc = new CrdtDocument();
    doc.apply(insert(makeId("A", 0), ROOT, "ok"));

    const idA = makeId("X", 1);
    const idB = makeId("X", 2);
    assert.equal(doc.apply(insert(idA, idB, "!")), "buffered");
    assert.equal(doc.apply(insert(idB, idA, "!")), "rejected-cycle");

    assert.ok(doc.isRejected(idA));
    assert.ok(doc.isRejected(idB));
    assert.equal(doc.bufferedCount, 0);
    assert.equal(doc.projection(), "ok");

    // replays of rejected ids stay rejected, never enter the tree
    assert.equal(doc.apply(insert(idA, idB, "!")), "rejected");
    assert.equal(doc.projection(), "ok");
  });

  test("self-loop is rejected immediately", () => {
    const doc = new CrdtDocument();
    const id = makeId("X", 9);
    assert.equal(doc.apply(insert(id, id, "?")), "rejected-cycle");
    assert.ok(doc.isRejected(id));
    assert.equal(doc.projection(), "");
  });

  test("node depending on a cycle member never enters the projection", () => {
    const doc = new CrdtDocument();
    const idA = makeId("X", 1);
    const idB = makeId("X", 2);
    const idC = makeId("X", 3);
    doc.apply(insert(idC, idA, "c")); // waits on A
    doc.apply(insert(idA, idB, "a")); // waits on B
    assert.equal(doc.apply(insert(idB, idA, "b")), "rejected-cycle");

    assert.ok(doc.isRejected(idA));
    assert.ok(doc.isRejected(idB));
    assert.ok(doc.isBuffered(idC)); // unresolvable, stays out of the tree
    assert.equal(doc.projection(), "");

    // document keeps accepting legitimate traffic
    doc.apply(insert(makeId("A", 0), ROOT, "z"));
    assert.equal(doc.projection(), "z");
  });
});

describe("shuffled + duplicated stream vs full in-order event log", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    test(`fuzz seed ${seed}: replicas converge to the reference projection`, () => {
      const rand = mulberry32(seed);
      const alphabet = "abcdefghij";

      // 1) generate a causal event log on one site
      const events: Message[] = [];
      const ids: string[] = [];
      let seq = 0;
      for (let i = 0; i < 300; i++) {
        if (ids.length === 0 || rand() < 0.7) {
          const id = makeId("S", seq++);
          const pred =
            ids.length === 0
              ? ROOT
              : (ids[Math.floor(rand() * ids.length)] as string);
          const value = alphabet[Math.floor(rand() * alphabet.length)] as string;
          events.push(insert(id, pred, value));
          ids.push(id);
        } else {
          events.push(del(ids[Math.floor(rand() * ids.length)] as string));
        }
      }

      // 2) reference: every event applied exactly once, in causal order
      const reference = new CrdtDocument();
      for (const e of events) reference.apply(e);

      // 3) three replicas get the same log shuffled and with duplicates
      for (let r = 0; r < 3; r++) {
        const rrand = mulberry32(seed * 100 + r);
        const stream: Message[] = [];
        for (const e of shuffled(events, rrand)) {
          const copies = 1 + Math.floor(rrand() * 3); // 1..3 copies
          for (let k = 0; k < copies; k++) stream.push(e);
        }
        const replica = new CrdtDocument();
        for (const e of shuffled(stream, rrand)) replica.apply(e);

        assert.equal(replica.projection(), reference.projection());
        assert.equal(replica.size, reference.size);
        assert.equal(replica.tombstoneCount, reference.tombstoneCount);
        assert.equal(replica.bufferedCount, 0);
      }
    });
  }
});
