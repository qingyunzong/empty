import assert from "node:assert/strict";
import test from "node:test";

import {
  DuplicateBusinessKeyError,
  normalizeSnapshot,
  resolveNormalizeContext,
} from "../index.ts";

test("snapshots accept checkedKeys, wrapped rows and direct row state", () => {
  const context = resolveNormalizeContext<{ id: string; selected?: boolean }>({
    keyField: "id",
  });
  const snapshot = normalizeSnapshot(
    {
      rows: [
        { id: "a" },
        { id: "b", selected: false },
        { key: "c", row: { id: "c" }, checked: true },
        { row: { id: "d" } },
      ],
      checkedKeys: ["a", "b"],
    },
    context,
  );

  assert.deepEqual(
    snapshot.rows.map((row) => [row.key, row.checked]),
    [
      ["a", true],
      // A direct row field is more specific than the page-level checkedKeys.
      ["b", false],
      ["c", true],
      ["d", false],
    ],
  );
});

test("a snapshot cannot contain the same business key twice", () => {
  const context = resolveNormalizeContext<{ id: number | string }>({
    keyField: "id",
  });
  assert.throws(
    () =>
      normalizeSnapshot(
        [
          { id: 7 },
          { id: "7" },
        ],
        context,
      ),
    DuplicateBusinessKeyError,
  );
});
