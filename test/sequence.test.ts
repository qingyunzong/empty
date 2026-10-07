import test from "node:test";
import assert from "node:assert/strict";
import { Sequence } from "../src/sequence.ts";
import type { Id, SequenceEvent } from "../src/sequence.ts";
import { Model } from "./model.ts";

function drain<T>(s: Sequence<T>): Array<{ id: Id; value: T }> {
  const cur = s.cursor();
  const out: Array<{ id: Id; value: T }> = [];
  for (;;) {
    const r = cur.next();
    if (r.done) break;
    out.push({ id: r.id, value: r.value });
  }
  cur.close();
  return out;
}

test("delete current item: next() moves to the original successor", () => {
  const s = new Sequence<string>();
  s.append("a");
  const b = s.append("b");
  const c = s.append("c");
  const cur = s.cursor();
  cur.next(); // a
  cur.next(); // b (cursor's current item)
  s.remove(b); // delete current item while cursor is anchored on it
  const r = cur.next();
  assert.equal(r.done, false);
  if (!r.done) {
    assert.equal(r.id, c); // original successor, no skip, no rewind
    assert.equal(r.value, "c");
  }
  assert.equal(cur.next().done, true);
  cur.close();
});

test("insert before cursor is not revisited; insert after cursor is visited", () => {
  const s = new Sequence<string>();
  const a = s.append("a");
  const b = s.append("b");
  const cur = s.cursor();
  cur.next(); // a; cursor now sits between a and b
  s.insertBefore(a, "x"); // behind the cursor
  const y = s.insertAfter(a, "y"); // ahead of the cursor
  const seen: Id[] = [];
  for (;;) {
    const r = cur.next();
    if (r.done) break;
    seen.push(r.id);
  }
  assert.deepEqual(seen, [y, b]); // "x" never revisited, "y" visited in place
  cur.close();
  assert.deepEqual(drain(s).map((e) => e.value), ["x", "a", "y", "b"]);
});

test("insert while cursor is at a tombstone: successor-side inserts are visited", () => {
  const s = new Sequence<string>();
  s.append("a");
  const b = s.append("b");
  const c = s.append("c");
  const cur = s.cursor();
  cur.next(); // a
  cur.next(); // b
  s.remove(b); // cursor anchored on tombstone of b
  const z = s.insertBefore(c, "z"); // between the tombstone and c
  const r1 = cur.next();
  const r2 = cur.next();
  assert.equal(r1.done === false && r1.id, z);
  assert.equal(r2.done === false && r2.id, c);
  cur.close();
});

test("reused IDs get a new generation; stale IDs are rejected", () => {
  const s = new Sequence<string>();
  const a = s.append("a");
  assert.equal(a, "0:1");
  s.remove(a);
  assert.equal(s.isValid(a), false);
  assert.throws(() => s.remove(a), /stale or unknown id/);
  assert.throws(() => s.insertAfter(a, "z"), /stale or unknown id/);
  assert.throws(() => s.insertBefore(a, "z"), /stale or unknown id/);
  assert.throws(() => s.get(a), /stale or unknown id/);
  const b = s.append("b"); // slot 0 reused with a bumped generation
  assert.equal(b, "0:2");
  assert.equal(s.isValid(b), true);
  assert.equal(s.get(b), "b");
  assert.throws(() => s.remove(a), /stale or unknown id/); // old generation stays stale
  assert.throws(() => s.cursor(a), /stale or unknown id/);
  assert.throws(() => s.get("nonsense"), /malformed id/);
});

test("closing a cursor releases its retained tombstone record", () => {
  const events: Array<SequenceEvent<string>> = [];
  const s = new Sequence<string>({ onEvent: (e) => events.push(e) });
  s.append("a");
  const b = s.append("b");
  s.append("c");
  const cur = s.cursor();
  cur.next();
  cur.next(); // anchored on b
  s.remove(b);
  assert.equal(s.tombstones, 1); // retained for the cursor
  cur.close();
  assert.equal(s.tombstones, 0); // released on close
  assert.deepEqual(
    events.filter((e) => e.type === "unlink"),
    [{ type: "unlink", id: b }],
  );
});

test("advancing past a tombstone releases it; last retainer wins", () => {
  const s = new Sequence<string>();
  s.append("a");
  const b = s.append("b");
  const c = s.append("c");
  const cur1 = s.cursor();
  const cur2 = s.cursor();
  cur1.next();
  cur1.next(); // cur1 anchored on b
  cur2.next();
  cur2.next(); // cur2 anchored on b
  s.remove(b);
  assert.equal(s.tombstones, 1);
  const r = cur1.next(); // cur1 moves on to c
  assert.equal(r.done === false && r.id, c);
  assert.equal(s.tombstones, 1); // cur2 still retains the record
  cur2.close();
  assert.equal(s.tombstones, 0); // last retainer released it
  cur1.close();
});

test("unretained removals leave no tombstone behind", () => {
  const s = new Sequence<string>();
  const a = s.append("a");
  s.remove(a);
  assert.equal(s.tombstones, 0);
  assert.equal(s.size, 0);
  assert.deepEqual(s.ids(), []);
});

test("closed cursor rejects next(); close is idempotent", () => {
  const s = new Sequence<string>();
  s.append("a");
  const cur = s.cursor();
  cur.close();
  cur.close();
  assert.equal(cur.closed, true);
  assert.throws(() => cur.next(), /cursor is closed/);
});

test("cursor opened at an ID resumes after that element", () => {
  const s = new Sequence<string>();
  s.append("a");
  const b = s.append("b");
  const c = s.append("c");
  const cur = s.cursor(b);
  const r = cur.next();
  assert.equal(r.done === false && r.id, c);
  cur.close();
});

test("scripted scenario produces the exact expected event sequence", () => {
  const events: Array<SequenceEvent<string>> = [];
  const s = new Sequence<string>({ onEvent: (e) => events.push(e) });
  const a = s.append("a");
  const b = s.append("b");
  const cur = s.cursor();
  cur.next();
  s.remove(a);
  cur.next();
  cur.close();
  assert.deepEqual(events, [
    { type: "insert", id: "0:1", value: "a", before: null },
    { type: "insert", id: "1:1", value: "b", before: null },
    { type: "open", cursor: 0, anchor: null },
    { type: "visit", cursor: 0, id: "0:1", value: "a" },
    { type: "remove", id: "0:1" },
    { type: "unlink", id: "0:1" }, // tombstone released as cursor advances
    { type: "visit", cursor: 0, id: "1:1", value: "b" },
    { type: "close", cursor: 0, anchor: "1:1" },
  ]);
  assert.equal(a, "0:1");
  assert.equal(b, "1:1");
});

// --- Randomized differential test against the tombstone-list model ---------

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

for (const seed of [1, 7, 42, 1337, 20261007]) {
  test(`event sequence matches tombstone-list model (seed ${seed})`, () => {
    const events: Array<SequenceEvent<number>> = [];
    const impl = new Sequence<number>({ onEvent: (e) => events.push(e) });
    const model = new Model<number>();
    const rand = mulberry32(seed);
    const pick = <U>(arr: U[]): U => arr[Math.floor(rand() * arr.length)]!;

    interface CursorPair {
      impl: ReturnType<Sequence<number>["cursor"]>;
      model: ReturnType<Model<number>["cursor"]>;
    }
    const open: CursorPair[] = [];
    let value = 0;

    const checkState = (step: number) => {
      assert.deepEqual(impl.ids(), model.ids(), `ids diverged at step ${step}`);
      assert.equal(impl.size, model.size, `size diverged at step ${step}`);
      assert.equal(
        impl.tombstones,
        model.tombstones,
        `tombstones diverged at step ${step}`,
      );
      assert.deepEqual(
        events,
        model.events,
        `event sequence diverged at step ${step}`,
      );
    };

    const steps = 600;
    for (let step = 0; step < steps; step++) {
      const live = model.ids();
      const op = Math.floor(rand() * 8);
      if (op === 0 || live.length === 0) {
        const id = impl.append(value);
        assert.equal(id, model.append(value));
        value++;
      } else if (op === 1) {
        const at = pick(live);
        const id = impl.insertAfter(at, value);
        assert.equal(id, model.insertAfter(at, value));
        value++;
      } else if (op === 2) {
        const at = pick(live);
        const id = impl.insertBefore(at, value);
        assert.equal(id, model.insertBefore(at, value));
        value++;
      } else if (op === 3) {
        const at = pick(live);
        impl.remove(at);
        model.remove(at);
      } else if (op === 4) {
        const at = rand() < 0.5 || live.length === 0 ? null : pick(live);
        open.push({ impl: impl.cursor(at), model: model.cursor(at) });
      } else if (op === 5 && open.length > 0) {
        const pair = pick(open);
        const ri = pair.impl.next();
        const rm = pair.model.next();
        assert.deepEqual(ri, rm, `next() diverged at step ${step}`);
      } else if (op === 6 && open.length > 0) {
        const i = Math.floor(rand() * open.length);
        const [pair] = open.splice(i, 1);
        pair!.impl.close();
        pair!.model.close();
      } else if (op === 7 && live.length > 0) {
        // Remove the element a random open cursor is most likely anchored on:
        // stresses tombstone retention and successor fallthrough.
        const at = live[Math.floor(rand() * Math.min(3, live.length))]!;
        impl.remove(at);
        model.remove(at);
      }
      checkState(step);
    }

    for (const pair of open) {
      pair.impl.close();
      pair.model.close();
    }
    checkState(steps);
    assert.equal(impl.tombstones, 0);
  });
}
