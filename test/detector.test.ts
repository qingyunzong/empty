import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AnomalyDetector, fullScan } from "../src/detector.js";

function segIds(detector: AnomalyDetector): number[] {
  return detector.segments().map((s) => s.id);
}

function assertMatchesFullScan(detector: AnomalyDetector, threshold: number): void {
  assert.deepEqual(detector.segments(), fullScan(detector.points(), threshold));
}

describe("AnomalyDetector basics", () => {
  test("empty detector has no segments", () => {
    const d = new AnomalyDetector(10);
    assert.deepEqual(d.segments(), []);
  });

  test("edge at or below threshold is not anomalous", () => {
    const d = new AnomalyDetector(10);
    d.insert(1, 0);
    d.insert(2, 10); // diff == threshold, not strictly greater
    assert.deepEqual(d.segments(), []);
    d.insert(3, 21); // 21 - 10 = 11 > 10
    assert.deepEqual(d.segments(), [{ id: 2, members: [2, 3] }]);
  });

  test("segment id is the minimum member id, not the first in sorted order", () => {
    const d = new AnomalyDetector(5);
    d.insert(9, 0);
    d.insert(3, 100);
    d.insert(7, 200);
    assert.deepEqual(d.segments(), [{ id: 3, members: [9, 3, 7] }]);
  });

  test("rejects duplicate insert and unknown delete", () => {
    const d = new AnomalyDetector(1);
    d.insert(1, 0);
    assert.throws(() => d.insert(1, 5), /duplicate/);
    assert.throws(() => d.delete(2), /unknown/);
  });

  test("rejects invalid threshold", () => {
    assert.throws(() => new AnomalyDetector(-1), /threshold/);
    assert.throws(() => new AnomalyDetector(NaN), /threshold/);
  });
});

describe("insert splits old edge", () => {
  test("splitting an anomalous edge can keep one merged segment", () => {
    const d = new AnomalyDetector(10);
    d.insert(0, 0);
    d.insert(2, 100); // edge 0-2 anomalous
    assert.deepEqual(d.segments(), [{ id: 0, members: [0, 2] }]);
    d.insert(1, 50); // splits 0-2 into 0-1 and 1-2, both anomalous
    assert.deepEqual(d.segments(), [{ id: 0, members: [0, 1, 2] }]);
    assertMatchesFullScan(d, 10);
  });

  test("splitting an anomalous edge can break a segment into two", () => {
    const d = new AnomalyDetector(10);
    d.insert(0, 0);
    d.insert(1, 50);
    d.insert(2, 100); // segment [0,1,2]
    assert.deepEqual(d.segments(), [{ id: 0, members: [0, 1, 2] }]);
    d.insert(3, 51); // splits edge 1-2 (diff 50) into 1-3 (diff 1) and 3-2 (diff 49)
    assert.deepEqual(d.segments(), [
      { id: 0, members: [0, 1] },
      { id: 2, members: [3, 2] },
    ]);
    assertMatchesFullScan(d, 10);
  });

  test("insert re-merges the two halves of the segment it split", () => {
    const d = new AnomalyDetector(10);
    d.insert(0, 0);
    d.insert(1, 100);
    d.insert(2, 200);
    d.insert(3, 300); // segment [0,1,2,3]
    // Splits anomalous edge 1-2; new edges 1-4 and 4-2 are both anomalous,
    // so the left part [0,1] and right part [2,3] merge back through 4.
    d.insert(4, 150);
    assert.deepEqual(d.segments(), [{ id: 0, members: [0, 1, 4, 2, 3] }]);
    assertMatchesFullScan(d, 10);
  });
});

describe("delete merges new edge", () => {
  test("deleting a middle point merges neighbours into an anomalous edge", () => {
    const d = new AnomalyDetector(10);
    d.insert(0, 0);
    d.insert(1, 5);
    d.insert(2, 100);
    assert.deepEqual(d.segments(), [{ id: 1, members: [1, 2] }]);
    d.delete(1); // new edge 0-2 diff 100 anomalous
    assert.deepEqual(d.segments(), [{ id: 0, members: [0, 2] }]);
    assertMatchesFullScan(d, 10);
  });

  test("deleting a bridging point splits one segment into two", () => {
    const d = new AnomalyDetector(10);
    d.insert(0, 0);
    d.insert(1, 100);
    d.insert(2, 105);
    d.insert(3, 200); // edges 0-1, 1-2(5, no), 2-3 -> segments [0,1] and [2,3]
    assert.deepEqual(segIds(d), [0, 2]);
    d.insert(4, 102); // 1-4 diff 2 no, 4-2 diff 3 no -> unchanged
    assert.deepEqual(segIds(d), [0, 2]);
    d.delete(4); // restores edge 1-2 (diff 5, not anomalous)
    assert.deepEqual(segIds(d), [0, 2]);
    d.delete(2); // merges 4? no: neighbours of 2 are 1(100) and 3(200) -> edge diff 100 anomalous -> [0,1,3]
    assert.deepEqual(d.segments(), [{ id: 0, members: [0, 1, 3] }]);
    assertMatchesFullScan(d, 10);
  });

  test("deleting an endpoint shrinks or dissolves a segment", () => {
    const d = new AnomalyDetector(10);
    d.insert(1, 0);
    d.insert(2, 100);
    d.insert(3, 200); // segment [1,2,3]
    d.delete(3); // edge 1-2 remains
    assert.deepEqual(d.segments(), [{ id: 1, members: [1, 2] }]);
    d.delete(2); // single point left, no edges
    assert.deepEqual(d.segments(), []);
    assertMatchesFullScan(d, 10);
  });

  test("delete can merge two segments through the new edge", () => {
    const d = new AnomalyDetector(10);
    // values: 0, 100, 105, 210 with ids 1..4; middle point id 5 at value 102
    d.insert(1, 0);
    d.insert(2, 100);
    d.insert(5, 102);
    d.insert(3, 105);
    d.insert(4, 210);
    // edges: 1-2 (100 A), 2-5 (2), 5-3 (3), 3-4 (105 A) -> segments [1,2] and [3,4]
    assert.deepEqual(segIds(d), [1, 3]);
    d.delete(5); // new edge 2-3 diff 5, not anomalous -> still two segments
    assert.deepEqual(segIds(d), [1, 3]);
    d.delete(2); // new edge 1-3 diff 105 anomalous -> merges into [1,3,4]
    assert.deepEqual(d.segments(), [{ id: 1, members: [1, 3, 4] }]);
    assertMatchesFullScan(d, 10);
  });
});

describe("duplicate values", () => {
  test("equal values order by id and never form anomalous edges among themselves", () => {
    const d = new AnomalyDetector(0); // any positive diff is anomalous
    d.insert(3, 5);
    d.insert(1, 5);
    d.insert(2, 5);
    assert.deepEqual(d.segments(), []);
    d.insert(4, 6); // diff 1 > 0 from id 3 (rightmost of the ties)
    assert.deepEqual(d.segments(), [{ id: 3, members: [3, 4] }]);
    assertMatchesFullScan(d, 0);
  });
});

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

describe("differential test against full edge scan", () => {
  const thresholds = [0, 1, 7, 25];
  for (const threshold of thresholds) {
    test(`random inserts/deletes match fullScan (threshold=${threshold})`, () => {
      const rand = mulberry32(0x9e3779b9 ^ threshold);
      const d = new AnomalyDetector(threshold);
      const live = new Set<number>();
      let nextId = 0;
      for (let step = 0; step < 4000; step++) {
        if (live.size === 0 || rand() < 0.6) {
          const id = nextId++;
          // Small value pool -> many edge splits, merges and duplicate values.
          const value = Math.floor(rand() * 40);
          d.insert(id, value);
          live.add(id);
        } else {
          const ids = [...live];
          const id = ids[Math.floor(rand() * ids.length)]!;
          d.delete(id);
          live.delete(id);
        }
        assertMatchesFullScan(d, threshold);
      }
      assert.ok(nextId > 0);
    });
  }

  test("larger scale spot-check every 50 steps", () => {
    const threshold = 100;
    const rand = mulberry32(123456789);
    const d = new AnomalyDetector(threshold);
    const live = new Set<number>();
    let nextId = 0;
    for (let step = 0; step < 20000; step++) {
      if (live.size === 0 || rand() < 0.55) {
        const id = nextId++;
        d.insert(id, Math.floor(rand() * 1000));
        live.add(id);
      } else {
        const ids = [...live];
        const id = ids[Math.floor(rand() * ids.length)]!;
        d.delete(id);
        live.delete(id);
      }
      if (step % 50 === 0) {
        assertMatchesFullScan(d, threshold);
      }
    }
    assertMatchesFullScan(d, threshold);
  });
});
