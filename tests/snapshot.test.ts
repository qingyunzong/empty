import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BadReferenceError,
  ValidationError,
  bytesValue,
  deserialize,
  deserializeFromString,
  Heap,
  intValue,
  refValue,
  serialize,
  serializeToString,
  valueEquals,
  type SnapshotDoc,
} from "../src/index.js";

/** 含共享引用、互环、自环、整数与字节串的样例图。 */
function sampleHeap(): Heap {
  const heap = new Heap();
  heap.allocate(1);
  heap.allocate(2);
  heap.allocate(3);
  heap.setField(1, "count", intValue(42));
  heap.setField(1, "payload", bytesValue(new Uint8Array([0, 1, 2, 255])));
  heap.setField(1, "next", refValue(2));
  heap.setField(2, "next", refValue(1));
  heap.setField(2, "shared", refValue(3));
  heap.setField(1, "sharedToo", refValue(3));
  heap.setField(3, "self", refValue(3));
  heap.setField(3, "empty", bytesValue(new Uint8Array([])));
  heap.setField(3, "neg", intValue(-7));
  return heap;
}

describe("serialize/deserialize", () => {
  it("preserves shared references through a round trip", () => {
    const restored = deserialize(serialize(sampleHeap()));
    assert.deepEqual(restored.getField(1, "sharedToo"), { kind: "ref", id: 3 });
    assert.deepEqual(restored.getField(2, "shared"), { kind: "ref", id: 3 });
    const doc = serialize(sampleHeap());
    assert.equal(doc.objects.filter((obj) => obj.id === 3).length, 1);
  });

  it("preserves mutual and self cycles", () => {
    const restored = deserialize(serialize(sampleHeap()));
    assert.deepEqual(restored.getField(1, "next"), { kind: "ref", id: 2 });
    assert.deepEqual(restored.getField(2, "next"), { kind: "ref", id: 1 });
    assert.deepEqual(restored.getField(3, "self"), { kind: "ref", id: 3 });
  });

  it("keeps object ids stable", () => {
    const restored = deserialize(serialize(sampleHeap()));
    assert.deepEqual(restored.objectIds(), [1, 2, 3]);
    const fresh = restored.allocate();
    assert.equal(fresh.id, 4);
  });

  it("round-trips integers including negatives and max safe integer", () => {
    const heap = new Heap();
    heap.allocate(1);
    heap.setField(1, "min", intValue(Number.MIN_SAFE_INTEGER));
    heap.setField(1, "max", intValue(Number.MAX_SAFE_INTEGER));
    heap.setField(1, "zero", intValue(0));
    const restored = deserialize(serialize(heap));
    for (const name of ["min", "max", "zero"]) {
      assert.ok(valueEquals(heap.getField(1, name)!, restored.getField(1, name)!));
    }
    assert.throws(() => intValue(1.5), ValidationError);
    assert.throws(() => intValue(Number.MAX_SAFE_INTEGER + 1), ValidationError);
  });

  it("round-trips byte strings including empty ones", () => {
    const restored = deserialize(serialize(sampleHeap()));
    assert.deepEqual(restored.getField(1, "payload"), {
      kind: "bytes",
      value: new Uint8Array([0, 1, 2, 255]),
    });
    assert.deepEqual(restored.getField(3, "empty"), {
      kind: "bytes",
      value: new Uint8Array([]),
    });
  });

  it("resolves forward references via two-phase loading", () => {
    const doc: SnapshotDoc = {
      format: "vm-snapshot/1",
      objects: [
        { id: 1, fields: { fwd: { t: "ref", id: 2 } } },
        { id: 2, fields: { back: { t: "ref", id: 1 } } },
      ],
    };
    const heap = deserialize(doc);
    assert.deepEqual(heap.getField(1, "fwd"), { kind: "ref", id: 2 });
    assert.deepEqual(heap.getField(2, "back"), { kind: "ref", id: 1 });
  });

  it("rejects the whole graph on a dangling reference", () => {
    const doc: SnapshotDoc = {
      format: "vm-snapshot/1",
      objects: [
        { id: 1, fields: { ok: { t: "int", v: 1 } } },
        { id: 2, fields: { dangling: { t: "ref", id: 99 } } },
      ],
    };
    assert.throws(() => deserialize(doc), BadReferenceError);
  });

  it("rejects malformed documents", () => {
    assert.throws(() => deserialize(null), ValidationError);
    assert.throws(() => deserialize({ format: "other/9", objects: [] }), ValidationError);
    assert.throws(
      () => deserialize({ format: "vm-snapshot/1", objects: [{ id: 1, fields: {} }, { id: 1, fields: {} }] }),
      ValidationError
    );
    assert.throws(
      () => deserialize({ format: "vm-snapshot/1", objects: [{ id: 1, fields: { b: { t: "bytes", v: "!!" } } }] }),
      ValidationError
    );
    assert.throws(
      () => deserialize({ format: "vm-snapshot/1", objects: [{ id: 1, fields: { x: { t: "nope" } } }] }),
      ValidationError
    );
    assert.throws(() => deserializeFromString("{not json"), ValidationError);
  });

  it("survives a JSON string round trip", () => {
    const json = serializeToString(sampleHeap());
    const restored = deserializeFromString(json);
    assert.deepEqual(serializeToString(restored), json);
  });
});
