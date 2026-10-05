import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReplaceSession,
  InvalidCaptureError,
} from "../src/index.js";

test("each round snapshots before binding and can be rolled back", () => {
  const session = new ReplaceSession("one two three");
  session.apply([{ start: 0, end: 3 }], "1"); // "1 two three"
  session.apply([{ start: 2, end: 5 }], "2"); // "1 2 three"
  session.apply([{ start: 4, end: 9 }], "3"); // "1 2 3"
  assert.equal(session.text, "1 2 3");
  assert.equal(session.depth, 3);

  assert.equal(session.rollback(), true);
  assert.equal(session.text, "1 2 three");
  assert.equal(session.depth, 2);

  assert.equal(session.rollback(), true);
  assert.equal(session.text, "1 two three");

  assert.equal(session.rollback(), true);
  assert.equal(session.text, "one two three");
  assert.equal(session.depth, 0);
  // Identity mapping restored: one run covering the whole text.
  assert.equal(session.sourcePositionAt(5), 5);
  assert.deepEqual(session.outputRangesForSource(5), [{ start: 0, end: 13 }]);

  assert.equal(session.rollback(), false); // nothing left to undo
});

test("a failed round does not modify the session", () => {
  const session = new ReplaceSession("abc");
  session.apply([{ start: 0, end: 1 }], "x");
  assert.equal(session.text, "xbc");
  assert.throws(
    () => session.apply([{ start: 0, end: 1 }], "$5"),
    InvalidCaptureError,
  );
  assert.equal(session.text, "xbc");
  assert.equal(session.depth, 1);
});

test("map after rollback no longer sees the undone round", () => {
  const session = new ReplaceSession("ab");
  session.apply([{ start: 0, end: 1 }], "[$&]"); // "[a]b"
  session.apply([{ start: 1, end: 2 }], "$&$&"); // "[aa]b"
  assert.equal(session.text, "[aa]b");
  assert.deepEqual(session.outputRangesForSource(0), [
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
  session.rollback();
  assert.equal(session.text, "[a]b");
  assert.deepEqual(session.outputRangesForSource(0), [{ start: 1, end: 2 }]);
});
