import { describe, it } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { Zone, createTransitionTable } from "../src/index.js";

describe("zone table revisions", () => {
  it("swaps tables atomically and bumps the version", () => {
    const zone = Zone.fromTransitions(0, []);
    equal(zone.version, 0);
    const v1 = zone.updateTable(createTransitionTable(3600, []));
    equal(v1, 1);
    equal(zone.version, 1);
    equal(zone.table.initialOffsetSeconds, 3600);
  });

  it("keeps old cursors bound to the old table", () => {
    const zone = Zone.fromTransitions(0, []);
    const oldCursor = zone.cursor();
    zone.updateTable(createTransitionTable(3600, []));
    const newCursor = zone.cursor();

    equal(oldCursor.version, 0);
    equal(newCursor.version, 1);

    // Same instant, different answers depending on the bound table.
    equal(oldCursor.utcToLocal(100).local, 100);
    equal(newCursor.utcToLocal(100).local, 3700);
    equal(oldCursor.offsetAt(100), 0);
    equal(newCursor.offsetAt(100), 3600);

    // Reverse mapping and inverse image follow the bound table too.
    equal(oldCursor.localToUtc(3700).candidates[0]!.utc, 3700);
    equal(newCursor.localToUtc(3700).candidates[0]!.utc, 100);
    deepEqual(
      oldCursor.localIntervalToUtc(0, 100).map((s) => [s.utcStart, s.utcEnd]),
      [[0, 100]],
    );
    deepEqual(
      newCursor.localIntervalToUtc(3600, 3700).map((s) => [s.utcStart, s.utcEnd]),
      [[0, 100]],
    );
  });

  it("revision with a new transition only affects new cursors", () => {
    const zone = Zone.fromTransitions(0, []);
    const before = zone.cursor();
    zone.updateTable(
      createTransitionTable(0, [{ atUtc: 1000, offsetSeconds: 3600 }]),
    );
    const after = zone.cursor();

    equal(before.localToUtc(2000).kind, "unique"); // old table: no gap
    equal(after.localToUtc(2000).kind, "none"); // new table: inside the gap
  });
});
