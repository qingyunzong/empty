import assert from "node:assert/strict";
import test from "node:test";
import {
  applyUpdateMask,
  combineUpdateMasks,
  decodeUpdateMask,
  explainUpdateMask,
  inferChangedColumns,
  isColumnUpdated,
  isMaskBitSet,
  maskBitPositions,
  parseUpdateMask,
  setColumnMaskBit,
} from "../index.ts";

const columns = ["id", "name", "qty", "note"];

test("decodes SQL Server LSB-first update masks", () => {
  assert.deepEqual(decodeUpdateMask(Uint8Array.from([0b00000101]), columns), ["id", "qty"]);
  assert.deepEqual(decodeUpdateMask("0x0a", columns), ["name", "note"]);
  assert.deepEqual(decodeUpdateMask(10, columns), ["name", "note"]);
  assert.deepEqual(maskBitPositions(0b101), [0, 2]);
  assert.equal(isMaskBitSet(0b101, 0), true);
  assert.equal(isMaskBitSet(0b101, 1), false);
  assert.equal(isColumnUpdated(0b101, 1), true);
  assert.equal(isColumnUpdated(0b101, 2), false);
  assert.deepEqual(parseUpdateMask(columns, "0x0a"), ["name", "note"]);
  assert.deepEqual(decodeUpdateMask(columns, "0x0a"), ["name", "note"]);
});

test("maps bits by column ordinal, not array position", () => {
  const schema = {
    captureInstance: "dbo_Sparse",
    columns: [
      { ordinal: 1, name: "id" },
      { ordinal: 3, name: "qty" },
    ],
  };
  assert.deepEqual(decodeUpdateMask(0b101, schema), ["id", "qty"]);
  assert.deepEqual(decodeUpdateMask(0b010, schema), []);

  const wide = Array.from({ length: 12 }, (_, index) => `c${index + 1}`);
  assert.deepEqual(decodeUpdateMask(Uint8Array.from([0, 0b00000100]), wide), ["c11"]);
});

test("explains changed and unchanged columns in ordinal order", () => {
  const explanation = explainUpdateMask("0x06", {
    columns: [
      { column_ordinal: 1, column_name: "id" },
      { column_ordinal: 2, column_name: "name" },
      { column_ordinal: 3, column_name: "qty" },
    ],
  });
  assert.deepEqual(explanation.columns, ["name", "qty"]);
  assert.deepEqual(explanation.ordinals, [2, 3]);
  assert.deepEqual(explanation.bits, [1, 2]);
  assert.equal(explanation.maskHex, "0x06");
  assert.deepEqual(
    explanation.columnsByOrdinal.map((column) => [column.name, column.updated]),
    [
      ["id", false],
      ["name", true],
      ["qty", true],
    ],
  );
});

test("sets bits without mutating the input mask", () => {
  const original = Uint8Array.from([0]);
  const updated = setColumnMaskBit(original, 10);
  assert.deepEqual([...original], [0]);
  assert.deepEqual([...updated], [0, 0b10]);
  assert.equal(isColumnUpdated(updated, 10), true);
  assert.deepEqual([...setColumnMaskBit(updated, 10, false)], [0, 0]);
});

test("combines masks and applies changed columns to a before image", () => {
  assert.deepEqual([...combineUpdateMasks(0b0001, 0b0100)], [0b0101]);
  const before = { id: 1, name: "old", qty: 2, note: "keep" };
  const after = { id: 1, name: "new", qty: 3, note: "changed but not selected" };
  assert.deepEqual(applyUpdateMask(before, after, 0b0010, columns), {
    id: 1,
    name: "new",
    qty: 2,
    note: "keep",
  });
});

test("infers changed columns when no mask is available", () => {
  assert.deepEqual(
    inferChangedColumns(
      { id: 1, name: "old", qty: 2, note: null },
      { id: 1, name: "new", qty: 2, note: null },
      columns,
    ),
    ["name"],
  );
});

test("rejects invalid schemas and masks", () => {
  assert.throws(() => decodeUpdateMask("0xzz", columns), /Invalid hexadecimal/);
  assert.throws(
    () =>
      decodeUpdateMask(0, {
        columns: [
          { ordinal: 1, name: "a" },
          { ordinal: 1, name: "b" },
        ],
      }),
    /Duplicate column ordinal/,
  );
  assert.throws(() => isColumnUpdated(1, 0), /Invalid column ordinal/);
});
