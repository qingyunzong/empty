import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  TimezoneDatabase,
  TransitionTable,
  verifySegment,
  type InverseSegment,
} from "../src/timezone.js";

/**
 * DST-like table, offsets in seconds, local = utc + offset:
 *   r0: +3600 on utc (-inf, 1000)
 *   r1: +7200 on utc [1000, 5000)   -> local gap   [4600, 8200)
 *   r2: +3600 on utc [5000, 9000)   -> local overlap [8600, 12200)
 *   r3: +7200 on utc [9000, +inf)   -> local gap   [12600, 16200)
 */
function dstTable(): TransitionTable {
  return new TransitionTable(3600, [
    { utcSecond: 1000, offsetSeconds: 7200 },
    { utcSecond: 5000, offsetSeconds: 3600 },
    { utcSecond: 9000, offsetSeconds: 7200 },
  ]);
}

describe("table construction", () => {
  test("fixed-offset table has a single open-ended rule", () => {
    const table = TransitionTable.fixed(3600);
    assert.equal(table.rules.length, 1);
    assert.equal(table.rules[0]!.offsetSeconds, 3600);
    assert.equal(table.rules[0]!.utcStart, -Infinity);
    assert.equal(table.rules[0]!.utcEnd, Infinity);
  });

  test("rejects unsorted transitions, no-op transitions and non-integers", () => {
    assert.throws(() => new TransitionTable(0, [
      { utcSecond: 200, offsetSeconds: 1 },
      { utcSecond: 100, offsetSeconds: 2 },
    ]));
    assert.throws(() => new TransitionTable(0, [{ utcSecond: 100, offsetSeconds: 0 }]));
    assert.throws(() => new TransitionTable(0, [
      { utcSecond: 100, offsetSeconds: 10 },
      { utcSecond: 200, offsetSeconds: 10 },
    ]));
    assert.throws(() => new TransitionTable(0.5));
    assert.throws(() => new TransitionTable(0, [{ utcSecond: Number.NaN, offsetSeconds: 1 }]));
  });

  test("tables are deeply frozen", () => {
    const table = dstTable();
    assert.ok(Object.isFrozen(table));
    assert.ok(Object.isFrozen(table.rules));
    assert.ok(Object.isFrozen(table.transitions));
    assert.ok(table.rules.every((rule) => Object.isFrozen(rule)));
  });
});

describe("forward and inverse mapping of single seconds", () => {
  const table = dstTable();

  test("utcToLocal applies the rule active at each UTC second", () => {
    assert.equal(table.utcToLocal(999), 4599);
    assert.equal(table.utcToLocal(1000), 8200); // first second after spring forward
    assert.equal(table.utcToLocal(4999), 12199);
    assert.equal(table.utcToLocal(5000), 8600); // first second after fall back
    assert.equal(table.utcToLocal(9000), 16200);
  });

  test("gap: local seconds with explicitly no solution", () => {
    assert.deepEqual(table.localToUtc(4600), { kind: "none" });
    assert.deepEqual(table.localToUtc(8199), { kind: "none" });
    assert.deepEqual(table.localToUtc(12600), { kind: "none" });
  });

  test("half-open boundaries around a gap", () => {
    assert.deepEqual(table.localToUtc(4599), { kind: "unique", utcSecond: 999 });
    assert.deepEqual(table.localToUtc(8200), { kind: "unique", utcSecond: 1000 });
  });

  test("overlap: local seconds with exactly two candidates, ascending", () => {
    assert.deepEqual(table.localToUtc(8600), { kind: "ambiguous", utcSeconds: [1400, 5000] });
    assert.deepEqual(table.localToUtc(12199), { kind: "ambiguous", utcSeconds: [4999, 8599] });
  });

  test("half-open boundaries around an overlap", () => {
    assert.deepEqual(table.localToUtc(8599), { kind: "unique", utcSecond: 1399 });
    assert.deepEqual(table.localToUtc(12200), { kind: "unique", utcSecond: 8600 });
  });

  test("fixed-offset table always maps uniquely", () => {
    const fixed = TransitionTable.fixed(-1800);
    assert.equal(fixed.utcToLocal(0), -1800);
    assert.deepEqual(fixed.localToUtc(-1800), { kind: "unique", utcSecond: 0 });
  });
});

describe("inverse image of local half-open intervals", () => {
  const table = dstTable();

  test("interval inside one rule maps to one segment with that source rule", () => {
    const segments = table.inverseImage(0, 1000);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.utcStart, -3600);
    assert.equal(segments[0]!.utcEnd, -2600);
    assert.equal(segments[0]!.parts.length, 1);
    assert.equal(segments[0]!.parts[0]!.rule.offsetSeconds, 3600);
  });

  test("interval fully inside a gap has an empty inverse image", () => {
    assert.deepEqual(table.inverseImage(4600, 8200), []);
    assert.deepEqual(table.inverseImage(5000, 5000), []); // empty interval
  });

  test("crossing a gap splits the image into disconnected UTC segments", () => {
    // local [4000, 9000): exists as [4000,4600) via r0, [8200,9000) via r1,
    // and [8600,9000) again via r2 after the fall back.
    const segments = table.inverseImage(4000, 9000);
    assert.equal(segments.length, 2);

    assert.equal(segments[0]!.utcStart, 400);
    assert.equal(segments[0]!.utcEnd, 1800);
    assert.deepEqual(segments[0]!.parts.map((p) => [p.utcStart, p.utcEnd, p.rule.offsetSeconds]), [
      [400, 1000, 3600],
      [1000, 1800, 7200],
    ]);

    assert.equal(segments[1]!.utcStart, 5000);
    assert.equal(segments[1]!.utcEnd, 5400);
    assert.equal(segments[1]!.parts.length, 1);
    assert.equal(segments[1]!.parts[0]!.rule.offsetSeconds, 3600);
  });

  test("crossing an overlap merges adjacent equivalent pieces into one segment", () => {
    // local [8600, 12200) is the overlap: covered once by r1 and once by r2.
    const segments = table.inverseImage(8600, 12200);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.utcStart, 1400);
    assert.equal(segments[0]!.utcEnd, 8600);
    assert.deepEqual(segments[0]!.parts.map((p) => [p.utcStart, p.utcEnd, p.rule.offsetSeconds]), [
      [1400, 5000, 7200],
      [5000, 8600, 3600],
    ]);
  });

  test("spanning multiple consecutive transitions yields one tiled segment", () => {
    const segments = table.inverseImage(0, 20000);
    assert.equal(segments.length, 1);
    const segment = segments[0]!;
    assert.equal(segment.utcStart, -3600);
    assert.equal(segment.utcEnd, 12800);
    assert.deepEqual(segment.parts.map((p) => p.rule.offsetSeconds), [3600, 7200, 3600, 7200]);
    // parts tile the segment without gaps
    for (let i = 1; i < segment.parts.length; i++) {
      assert.equal(segment.parts[i]!.utcStart, segment.parts[i - 1]!.utcEnd);
    }
  });
});

describe("exhaustive verification on small UTC domains", () => {
  const table = dstTable();

  test("forward round-trip holds across every transition", () => {
    const report = table.verifyForward(-4000, 13000);
    assert.equal(report.checked, 17000);
    assert.ok(report.ok, `failures: ${report.failures}`);
  });

  test("forward round-trip holds for back-to-back transitions", () => {
    const dense = new TransitionTable(0, [
      { utcSecond: 100, offsetSeconds: 10 },
      { utcSecond: 101, offsetSeconds: 0 },
      { utcSecond: 102, offsetSeconds: -20 },
    ]);
    assert.ok(dense.verifyForward(0, 300).ok);
  });

  test("every inverse-image segment verifies exhaustively against its local interval", () => {
    const localStart = 4000;
    const localEnd = 13000;
    for (const segment of table.inverseImage(localStart, localEnd)) {
      const result = verifySegment(table, segment, localStart, localEnd);
      assert.ok(result.exhaustive);
      assert.ok(result.ok, `failures: ${result.failures}`);
      assert.equal(result.checked, segment.utcEnd - segment.utcStart);
    }
  });

  test("oversized domains are reported as non-exhaustive", () => {
    const segment: InverseSegment = table.inverseImage(0, 20000)[0]!;
    const result = verifySegment(table, segment, 0, 20000, 100);
    assert.equal(result.exhaustive, false);
    assert.equal(result.checked, 0);
  });
});

describe("atomic table revision and cursor binding", () => {
  test("replace swaps the visible table and returns the previous one", () => {
    const v1 = TransitionTable.fixed(0);
    const v2 = TransitionTable.fixed(3600);
    const db = new TimezoneDatabase(v1);
    assert.equal(db.utcToLocal(100), 100);

    const previous = db.replace(v2);
    assert.equal(previous, v1);
    assert.equal(db.current, v2);
    assert.equal(db.utcToLocal(100), 3700);
    // the old table object is untouched
    assert.equal(v1.utcToLocal(100), 100);
  });

  test("cursors stay bound to the table version they were created from", () => {
    const v1 = new TransitionTable(0, [{ utcSecond: 100, offsetSeconds: 3600 }]);
    const v2 = new TransitionTable(0, [
      { utcSecond: 50, offsetSeconds: 1800 },
      { utcSecond: 60, offsetSeconds: 0 },
    ]);
    const db = new TimezoneDatabase(v1);
    const oldCursor = db.cursor();

    db.replace(v2);
    const newCursor = db.cursor();

    assert.equal(oldCursor.table, v1);
    assert.deepEqual(oldCursor.next(), { utcSecond: 100, offsetSeconds: 3600 });
    assert.equal(oldCursor.next(), undefined);

    assert.equal(newCursor.table, v2);
    assert.deepEqual(newCursor.next(), { utcSecond: 50, offsetSeconds: 1800 });
    assert.deepEqual(newCursor.next(), { utcSecond: 60, offsetSeconds: 0 });
    assert.equal(newCursor.next(), undefined);
  });

  test("cursor supports peek, position and reset", () => {
    const table = dstTable();
    const cursor = table.cursor();
    assert.equal(cursor.position, 0);
    assert.deepEqual(cursor.peek(), { utcSecond: 1000, offsetSeconds: 7200 });
    assert.deepEqual(cursor.next(), { utcSecond: 1000, offsetSeconds: 7200 });
    assert.equal(cursor.position, 1);
    cursor.reset();
    assert.equal(cursor.position, 0);
    assert.deepEqual(cursor.next(), { utcSecond: 1000, offsetSeconds: 7200 });
  });
});
