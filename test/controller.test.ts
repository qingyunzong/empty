import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionJournal,
  DuplicateBusinessKeyError,
  RowNotFoundError,
  SnapshotConfirmationError,
  TableSelectionController,
  TableSelectionStore,
} from "../index.ts";
import type { BusinessKey, TablePageInput } from "../index.ts";

interface Row {
  id: string;
  status: "active" | "inactive";
  selected: boolean;
  disabled?: boolean;
}

class FakeTableAdapter {
  rows: Row[] = [];
  clicks: Array<{ key: BusinessKey; checked: boolean }> = [];
  snapshotCalls = 0;
  locateCalls: BusinessKey[] = [];
  scrollCalls: BusinessKey[] = [];
  failNextSnapshot = false;
  locateRows: Row[] | undefined;

  async snapshot(): Promise<TablePageInput<Row>> {
    this.snapshotCalls += 1;
    if (this.failNextSnapshot) {
      this.failNextSnapshot = false;
      throw new Error("transient snapshot failure");
    }
    return { rows: this.rows.map((row) => ({ ...row })) };
  }

  async locateRow(key: BusinessKey): Promise<TablePageInput<Row> | void> {
    this.locateCalls.push(key);
    if (this.locateRows !== undefined) {
      this.rows = this.locateRows.map((row) => ({ ...row }));
    }
  }

  async scrollToRow(key: BusinessKey): Promise<void> {
    this.scrollCalls.push(key);
  }

  async setRowChecked(key: BusinessKey, checked: boolean): Promise<void> {
    this.clicks.push({ key, checked });
    const row = this.rows.find((candidate) => candidate.id === String(key));
    if (row === undefined) {
      throw new Error("row disappeared before click");
    }
    row.selected = checked;
  }

  async *pages(): AsyncIterable<TablePageInput<Row>> {
    yield { rows: this.rows.slice(0, 2).map((row) => ({ ...row })) };
    yield { rows: this.rows.slice(2).map((row) => ({ ...row })) };
  }
}

test("controller clicks only matching rows and confirms each snapshot", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [
    { id: "a", status: "active", selected: false },
    { id: "b", status: "inactive", selected: false },
    { id: "c", status: "active", selected: false },
  ];
  const store = new TableSelectionStore<Row>({ keyField: "id" });
  const controller = new TableSelectionController<Row>({
    adapter,
    store,
    predicate: (row) => row.status === "active",
    maxAttempts: 3,
  });

  const result = await controller.run(["a", "b", "c"]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.results.map((item) => [item.key, item.status]),
    [
      ["a", "selected"],
      ["b", "skipped-predicate"],
      ["c", "selected"],
    ],
  );
  assert.deepEqual(adapter.clicks, [
    { key: "a", checked: true },
    { key: "c", checked: true },
  ]);
  assert.deepEqual(store.selectedKeys, ["a", "c"]);
  // One preflight snapshot per action plus one confirmation snapshot per click.
  assert.equal(adapter.snapshotCalls, 5);
});

test("a refresh that invalidates the predicate prevents the click", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: false }];
  const controller = new TableSelectionController<Row>({
    adapter,
    predicate: (row) => row.status === "active",
  });

  await controller.capture();
  adapter.rows[0].status = "inactive";

  const result = await controller.select("a");
  assert.equal(result.status, "skipped-predicate");
  assert.equal(adapter.clicks.length, 0);
});

test("duplicate target keys and duplicate snapshot keys stop before clicking", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: false }];
  const controller = new TableSelectionController<Row>({ adapter });

  await assert.rejects(
    controller.run(["a", "a"]),
    DuplicateBusinessKeyError,
  );
  assert.equal(adapter.clicks.length, 0);

  adapter.rows.push({ id: "a", status: "active", selected: false });
  await assert.rejects(
    controller.select("a"),
    DuplicateBusinessKeyError,
  );
  assert.equal(adapter.clicks.length, 0);
});

test("a missing row key stops the action", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: false }];
  const controller = new TableSelectionController<Row>({ adapter });

  await assert.rejects(
    controller.select("missing"),
    RowNotFoundError,
  );
  assert.equal(adapter.clicks.length, 0);
});

test("a retry after a lost confirmation does not click twice", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: false }];
  const journal = new ActionJournal();
  const controller = new TableSelectionController<Row>({
    adapter,
    journal,
    maxAttempts: 3,
  });

  const originalSet = adapter.setRowChecked.bind(adapter);
  adapter.setRowChecked = async (key, checked) => {
    await originalSet(key, checked);
    // The click succeeded, but the first confirmation snapshot is lost.
    adapter.failNextSnapshot = true;
  };

  const result = await controller.select("a");
  // The retry observes the already-checked row and records success without
  // issuing a second click.
  assert.equal(result.status, "already-selected");
  assert.equal(adapter.clicks.length, 1);
  assert.equal(journal.hasSucceeded("select", "a"), true);
});

test("journal successes are never triggered again", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: false }];
  const journal = new ActionJournal();
  const first = new TableSelectionController<Row>({ adapter, journal });
  await first.select("a");
  assert.equal(adapter.clicks.length, 1);

  const retry = new TableSelectionController<Row>({ adapter, journal });
  const result = await retry.select("a");
  assert.equal(result.status, "skipped-journal");
  assert.equal(adapter.clicks.length, 1);
});

test("an already checked row is not clicked and is recorded as done", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: true }];
  const journal = new ActionJournal();
  const controller = new TableSelectionController<Row>({ adapter, journal });

  const result = await controller.select("a");
  assert.equal(result.status, "already-selected");
  assert.equal(adapter.clicks.length, 0);
  assert.equal(journal.hasSucceeded("select", "a"), true);
});

test("virtualized rows are located and scrolled before acting", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "x", status: "active", selected: false }];
  adapter.locateRows = [{ id: "b", status: "active", selected: false }];
  const controller = new TableSelectionController<Row>({ adapter });

  const result = await controller.select("b");
  assert.equal(result.status, "selected");
  assert.deepEqual(adapter.locateCalls, ["b"]);
  assert.deepEqual(adapter.clicks, [{ key: "b", checked: true }]);
});

test("runMatching collects keys over server-side pages before acting", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [
    { id: "a", status: "active", selected: false },
    { id: "b", status: "inactive", selected: false },
    { id: "c", status: "active", selected: false },
    { id: "d", status: "active", selected: false },
  ];
  adapter.locateRows = adapter.rows;
  const controller = new TableSelectionController<Row>({
    adapter,
    predicate: (row) => row.status === "active",
  });

  const keys = await controller.collectMatchingKeys();
  assert.deepEqual(keys, ["a", "c", "d"]);
  const result = await controller.runMatching();
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.status), [
    "selected",
    "selected",
    "selected",
  ]);
});

test("a post-action snapshot mismatch becomes a confirmation failure", async () => {
  const adapter = new FakeTableAdapter();
  adapter.rows = [{ id: "a", status: "active", selected: false }];
  adapter.setRowChecked = async (key) => {
    adapter.clicks.push({ key, checked: true });
    // Pretend the UI ignored the click.
  };
  const controller = new TableSelectionController<Row>({
    adapter,
    maxAttempts: 2,
  });

  await assert.rejects(
    controller.select("a"),
    SnapshotConfirmationError,
  );
  assert.equal(adapter.clicks.length, 2);
});
