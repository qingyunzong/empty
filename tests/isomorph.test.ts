import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  areIsomorphic,
  assertIsomorphic,
  SnapshotError,
  bytesValue,
  Heap,
  intValue,
  refValue,
  verifyRoundTrip,
} from "../src/index.js";

function graphA(): Heap {
  const heap = new Heap();
  heap.allocate(1);
  heap.allocate(2);
  heap.allocate(3);
  heap.setField(1, "n", intValue(10));
  heap.setField(1, "to", refValue(2));
  heap.setField(2, "to", refValue(3));
  heap.setField(3, "to", refValue(1));
  heap.setField(3, "data", bytesValue(new Uint8Array([9, 8])));
  return heap;
}

/** 与 graphA 同构但 ID 完全不同、边方向经重标号的图。 */
function graphARelabeled(): Heap {
  const heap = new Heap();
  heap.allocate(31);
  heap.allocate(17);
  heap.allocate(24);
  heap.setField(24, "n", intValue(10));
  heap.setField(24, "to", refValue(31));
  heap.setField(31, "to", refValue(17));
  heap.setField(17, "to", refValue(24));
  heap.setField(17, "data", bytesValue(new Uint8Array([9, 8])));
  return heap;
}

describe("graph isomorphism", () => {
  it("verifies round-trip isomorphism", () => {
    const heap = graphA();
    const restored = verifyRoundTrip(heap);
    assertIsomorphic(heap, restored);
    assert.equal(restored.size, 3);
  });

  it("accepts isomorphic graphs with relabeled ids", () => {
    assert.ok(areIsomorphic(graphA(), graphARelabeled()));
  });

  it("rejects graphs with different literals", () => {
    const other = graphARelabeled();
    other.setField(24, "n", intValue(11));
    assert.ok(!areIsomorphic(graphA(), other));
  });

  it("rejects graphs with different edge structure", () => {
    const other = graphARelabeled();
    other.setField(31, "to", refValue(24));
    assert.ok(!areIsomorphic(graphA(), other));
  });

  it("rejects graphs of different size", () => {
    const other = graphARelabeled();
    other.allocate(99);
    assert.ok(!areIsomorphic(graphA(), other));
    assert.throws(() => assertIsomorphic(graphA(), other), SnapshotError);
  });
});
