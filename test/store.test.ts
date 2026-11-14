import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateBusinessKeyError,
  MissingBusinessKeyError,
  TableSelectionStore,
} from "../index.ts";

interface Row {
  id: string;
  status: "active" | "inactive";
  selected?: boolean;
  disabled?: boolean;
}

test("selection is keyed by business key across pages, sorting and filtering", () => {
  const store = new TableSelectionStore<Row>({ keyField: "id" });

  store.observe([
    { id: "a", status: "active", selected: false },
    { id: "b", status: "active", selected: false },
  ]);
  store.select("a");
  store.select("b");
  assert.deepEqual(store.selectedKeys, ["a", "b"]);

  // Server-side sort/filter returns a different page, with a different order
  // and without any previously mounted row. The target set must survive.
  store.observe([
    { id: "d", status: "active" },
    { id: "c", status: "active" },
  ]);
  assert.deepEqual(store.selectedKeys, ["a", "b"]);

  // The same key may come back from the DOM as text rather than a number.
  store.select(7);
  store.observe([{ id: "7", status: "active" }]);
  assert.equal(store.has("7"), true);
  assert.equal(store.has(7), true);
  assert.deepEqual(store.selectedKeys, ["a", "b", 7]);
});

test("duplicate or missing keys stop before selection changes", () => {
  const store = new TableSelectionStore<Row>({ keyField: "id" });
  store.select("safe");

  assert.throws(
    () =>
      store.observe([
        { id: "x", status: "active" },
        { id: "x", status: "active" },
      ]),
    DuplicateBusinessKeyError,
  );
  assert.deepEqual(store.selectedKeys, ["safe"]);

  assert.throws(
    () => store.observe([{ status: "active" } as Row]),
    MissingBusinessKeyError,
  );
  assert.throws(() => store.selectMany(["ok", "ok"]), DuplicateBusinessKeyError);
  assert.throws(() => store.replace([""]), MissingBusinessKeyError);
});

test("reconcile drops only rows that are visibly stale", () => {
  const store = new TableSelectionStore<Row>({
    keyField: "id",
    predicate: (row) => row.status === "active",
  });
  store.observe([
    { id: "a", status: "active" },
    { id: "b", status: "active" },
  ]);
  store.selectMany(["a", "b"]);
  store.observe([{ id: "c", status: "active" }]);

  assert.deepEqual(store.selectedKeys, ["a", "b"]);

  // `a` is now inactive on the fresh page, but `b` is not mounted on this page
  // and therefore cannot be proven stale.
  store.reconcile([
    { id: "a", status: "inactive" },
    { id: "c", status: "active" },
  ]);
  assert.deepEqual(store.selectedKeys, ["b"]);
});

test("selection state and journal are serializable across a refresh", () => {
  const store = new TableSelectionStore<Row>({ keyField: "id" });
  store.selectMany(["a", "b"]);
  const restored = TableSelectionStore.fromJSON<Row>(
    JSON.stringify(store.toJSON()),
  );
  assert.deepEqual(restored.selectedKeys, ["a", "b"]);

  const view = store.getSnapshot();
  assert.equal(view.selectedCount, 2);
  assert.deepEqual([...view.selectedKeySet], ["a", "b"]);
});
