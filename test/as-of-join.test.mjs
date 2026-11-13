import test from "node:test";
import assert from "node:assert/strict";

import {
  AsOfJoin,
  asOfJoin,
  createAsOfJoin,
} from "../dist/index.js";

const right = (key, time, sourceSeq, value) => ({
  key,
  time,
  sourceSeq,
  value,
});

const left = (key, time, value) => ({ key, time, value });

test("picks the newest right version not later than the left event", () => {
  const rights = [
    right("a", 100, 1, "a@100"),
    right("a", 200, 1, "a@200"),
    right("b", 150, 1, "b@150"),
  ];
  const lefts = [
    left("a", 250, "a@250"),
    left("a", 90, "a@90"),
    left("b", 160, "b@160"),
    left("c", 1, "c@1"),
  ];

  const results = asOfJoin(lefts, rights, { tolerance: 50 });

  assert.equal(results[0].right.value, "a@200");
  assert.equal(results[0].rightTime, 200);
  assert.equal(results[1].right, null);
  assert.equal(results[2].right.value, "b@150");
  assert.equal(results[3].right, null);
  assert.deepEqual(
    results.map((result) => result.left.value),
    ["a@250", "a@90", "b@160", "c@1"],
  );
});

test("tolerance is inclusive and rights newer than the left never match", () => {
  const rights = [right("a", 200, 1, "v200")];

  const atBoundary = asOfJoin([left("a", 210, "L")], rights, {
    tolerance: 10,
  });
  const outside = asOfJoin([left("a", 211, "L")], rights, {
    tolerance: 10,
  });
  const future = asOfJoin([left("a", 199, "L")], rights, {
    tolerance: 10,
  });

  assert.equal(atBoundary[0].right.value, "v200");
  assert.equal(outside[0].right, null);
  assert.equal(future[0].right, null);
});

test("same-time rights are resolved by source sequence", () => {
  const rights = [
    right("a", 100, 7, "seq-7"),
    right("a", 100, 3, "seq-3"),
    right("a", 100, 5, "seq-5"),
  ];

  const latest = asOfJoin([left("a", 100, "L")], rights);
  const earliest = asOfJoin([left("a", 100, "L")], rights, {
    tieBreak: "min-source-seq",
  });

  assert.equal(latest[0].right.value, "seq-7");
  assert.equal(latest[0].rightSourceSeq, 7);
  assert.equal(earliest[0].right.value, "seq-3");
});

test("batch indexing is independent of right-arrival order", () => {
  const rights = [
    right("a", 100, 1, "v100"),
    right("a", 120, 1, "v120"),
    right("a", 80, 2, "v80"),
    right("a", 120, 2, "v120-seq2"),
  ];

  const results = asOfJoin(
    [left("a", 105, "L105"), left("a", 120, "L120")],
    rights,
    { tolerance: 100 },
  );

  assert.equal(results[0].right.value, "v100");
  assert.equal(results[1].right.value, "v120-seq2");
});

test("watermark sorts bounded out-of-order rights before closing a left", () => {
  const join = new AsOfJoin({ tolerance: 30, maxOutOfOrderness: 50 });
  const emitted = [];

  join.addRight(right("a", 100, 1, "v100"));
  join.addRight(right("a", 120, 1, "v120"));
  join.addRight(right("a", 80, 1, "v80"));
  emitted.push(...join.addLeft(left("a", 105, "L105")));

  assert.equal(join.watermark, 70);
  assert.equal(join.pendingCount, 1);

  // 170 - 50 = 120, so the left at 105 is now closed.
  emitted.push(...join.addRight(right("other", 170, 1, "ignored")));

  assert.equal(join.pendingCount, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].right.value, "v100");
});

test("a late right cannot rewrite an emitted result", () => {
  const join = new AsOfJoin({ tolerance: 100 });

  join.addLeft(left("a", 100, "L100"));
  join.advanceWatermark(150);

  assert.equal(join.resultCount, 1);
  assert.equal(join.results[0].right, null);

  join.addRight(right("a", 90, 9, "late-v90"));

  assert.equal(join.resultCount, 1);
  assert.equal(join.results[0].right, null);
  assert.equal(join.lateRightCount, 1);
  assert.equal(join.droppedRightCount, 1);
  assert.equal(join.acceptedRightCount, 0);

  // The dropped late value is not available to later left events either.
  join.addLeft(left("a", 160, "L160"));
  join.advanceWatermark(200);
  assert.equal(join.results[1].right, null);
});

test("latePolicy keep retains late values only for future left events", () => {
  const join = new AsOfJoin({ tolerance: 100, latePolicy: "keep" });

  const first = join.addLeft(left("a", 100, "L100"));
  assert.equal(first.length, 0);

  join.advanceWatermark(150);
  assert.equal(join.results[0].right, null);

  join.addRight(right("a", 90, 9, "late-v90"));
  assert.equal(join.results[0].right, null);
  assert.equal(join.lateRightCount, 1);

  join.addLeft(left("a", 160, "L160"));
  join.advanceWatermark(300);

  assert.equal(join.results[1].right.value, "late-v90");
});

test("flush and close finalize pending lefts and seal the stream", () => {
  const join = createAsOfJoin({ tolerance: 10 });
  join.addRight(right("a", 100, 1, "v100"));
  join.addLeft(left("a", 105, "L105"));

  const flushed = join.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].right.value, "v100");

  join.addRight(right("a", 200, 1, "after-flush"));
  join.addLeft(left("a", 205, "L205"));

  const closed = join.close();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].right.value, "after-flush");
  assert.equal(join.closed, true);

  const before = join.results.length;
  const afterClose = join.addRight(right("a", 100, 2, "too-late"));
  assert.deepEqual(afterClose, []);
  assert.equal(join.results.length, before);
});

test("onResult receives every emitted result exactly once", () => {
  const seen = [];
  const join = new AsOfJoin({
    onResult: (result) => seen.push(result),
  });

  join.addRight(right("a", 10, 1, "v10"));
  join.addLeft(left("a", 11, "L11"));
  join.advanceWatermark(20);
  join.flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0], join.results[0]);
});

test("custom accessors and tagged push events are supported", () => {
  const join = new AsOfJoin({
    tolerance: 5,
    key: (event) => event.id,
    time: (event) => event.ts,
    sourceSeq: (event) => event.seq,
  });

  join.push({ type: "right", id: "x", ts: 100, seq: 2, value: "new" });
  join.push({ type: "right", id: "x", ts: 100, seq: 1, value: "old" });
  join.push({ side: "left", id: "x", ts: 104, value: "left" });

  const results = join.close();
  assert.equal(results.length, 1);
  assert.equal(results[0].right.value, "new");
});
