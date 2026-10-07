import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BadReferenceError,
  Heap,
  intValue,
  refValue,
  VM,
  type SnapshotDoc,
} from "../src/index.js";

describe("VM atomic restore", () => {
  it("restores a snapshot taken earlier", () => {
    const vm = new VM();
    vm.heap.allocate(1);
    vm.heap.allocate(2);
    vm.heap.setField(1, "x", intValue(7));
    vm.heap.setField(1, "peer", refValue(2));
    vm.heap.setField(2, "peer", refValue(1));
    const doc = vm.snapshot();

    const vm2 = new VM();
    vm2.restore(doc);
    assert.deepEqual(vm2.heap.objectIds(), [1, 2]);
    assert.deepEqual(vm2.heap.getField(1, "peer"), { kind: "ref", id: 2 });
  });

  it("per-field failure does not pollute the old heap", () => {
    const vm = new VM();
    vm.heap.allocate(1);
    vm.heap.setField(1, "x", intValue(7));
    const before = vm.heap;

    const bad: SnapshotDoc = {
      format: "vm-snapshot/1",
      objects: [
        { id: 1, fields: { good: { t: "int", v: 1 } } },
        { id: 2, fields: { boom: { t: "ref", id: 404 } } },
      ],
    };
    assert.throws(() => vm.restore(bad), BadReferenceError);
    assert.equal(vm.heap, before);
    assert.deepEqual(vm.heap.objectIds(), [1]);
    assert.deepEqual(vm.heap.getField(1, "x"), { kind: "int", value: 7 });
  });

  it("rejects a corrupt JSON string without touching the old heap", () => {
    const vm = new VM();
    vm.heap.allocate(5);
    const before = vm.heap;
    assert.throws(() => vm.restoreString("{broken"));
    assert.equal(vm.heap, before);
    assert.deepEqual(vm.heap.objectIds(), [5]);
  });
});

describe("Heap field-level atomicity", () => {
  it("failed setField leaves the previous value intact", () => {
    const heap = new Heap();
    heap.allocate(1);
    heap.setField(1, "p", intValue(1));
    assert.throws(() => heap.setField(1, "p", refValue(99)), BadReferenceError);
    assert.deepEqual(heap.getField(1, "p"), { kind: "int", value: 1 });
  });

  it("auto ids continue after the largest explicit id", () => {
    const heap = new Heap();
    heap.allocate(10);
    assert.equal(heap.allocate().id, 11);
  });
});
