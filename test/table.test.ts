import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTableStructure,
  MergedRangeOverlapError,
  rangeFromA1,
  readCell,
  tableToRecords,
} from "../index.ts";

test("builds multi-level headers and maps data with original coordinates", () => {
  const table = buildTableStructure(
    {
      rows: [
        ["Sales", null, "Info", null],
        ["Q1", "Q2", "Name", "Name"],
        [{ formula: "=1+1", v: 2 }, 20, "Alice", "A"],
        ["hidden", "ignored", "ignored", "ignored"],
        [5, 50, "Carol", "C"],
      ],
      merges: ["A1:B1", "C1:D1"],
      hiddenRows: [3],
      hiddenColumns: [1],
    },
    { headerRows: 2 },
  );

  assert.deepEqual(
    table.headers.map((header) => header.key),
    ["Sales / Q1", "Info / Name", "Info / Name #2"],
  );
  assert.deepEqual(table.headers[0].path, ["Sales", "Q1"]);
  assert.equal(table.headers[0].columnIndex, 0);
  assert.equal(table.headers[1].columnIndex, 2);
  assert.equal(table.headers[1].duplicate, false);
  assert.equal(table.headers[2].duplicate, true);
  assert.equal(table.headerDepth, 2);

  assert.deepEqual(table.rows.map((row) => row.rowIndex), [2, 4]);
  assert.deepEqual(table.rows[0].values, {
    "Sales / Q1": 2,
    "Info / Name": "Alice",
    "Info / Name #2": "A",
  });
  assert.deepEqual(table.rows[1].values, {
    "Sales / Q1": 5,
    "Info / Name": "Carol",
    "Info / Name #2": "C",
  });
  assert.equal(table.rows[0].cells[0].address, "A3");
  assert.equal(table.rows[1].cells[0].address, "A5");
  assert.equal(readCell(table, 4, ["Info", "Name"]), "Carol");
  assert.deepEqual(tableToRecords(table)[1], table.rows[1].values);
});

test("empty headers inherit only inside their own merged range", () => {
  const table = buildTableStructure(
    {
      rows: [
        [null, "Merged", null, null],
        ["A", "B", "C", "D"],
        [1, 2, 3, 4],
      ],
      mergedRanges: ["B1:C1"],
    },
    { headerRows: 2 },
  );

  assert.deepEqual(table.headers[0].path, ["A"]);
  assert.deepEqual(table.headers[1].path, ["Merged", "B"]);
  assert.deepEqual(table.headers[2].path, ["Merged", "C"]);
  assert.deepEqual(table.headers[3].path, ["D"]);
  assert.equal(table.headers[0].name, "A");
  assert.equal(table.headers[1].name, "B");
});

test("vertical merges contribute one level rather than repeated labels", () => {
  const table = buildTableStructure(
    {
      rows: [
        ["Group", "Other"],
        [null, "Leaf"],
        [1, 2],
      ],
      merges: ["A1:A2"],
    },
    { headerRows: 2 },
  );

  assert.deepEqual(table.headers[0].path, ["Group"]);
  assert.deepEqual(table.headers[0].levels, ["Group", null]);
  assert.deepEqual(table.headers[1].path, ["Other", "Leaf"]);
});

test("overlapping merged ranges are rejected", () => {
  assert.throws(
    () =>
      buildTableStructure({
        rows: [[1, 2], [3, 4]],
        merges: ["A1:B2", "B2:C3"],
      }),
    (error: unknown) =>
      error instanceof MergedRangeOverlapError &&
      /A1:B2 and B2:C3/.test(error.message),
  );

  assert.throws(
    () =>
      buildTableStructure({
        rows: [[1]],
        merges: [
          { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
          { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 },
        ],
      }),
    (error: unknown) =>
      error instanceof MergedRangeOverlapError,
  );
});

test("formula cells use cached values from cells and the sheet cache", () => {
  const table = buildTableStructure(
    {
      rows: [
        [{ formula: "=A1", cachedValue: "Header" }, "B"],
        [{ formula: "=1+1", result: 2 }, { f: "=2+2" }],
        [{ value: { formula: "=3+3", result: 6 } }, 8],
      ],
      formulaCache: { B2: { value: 4 } },
    },
    { headerRows: 1 },
  );

  assert.equal(table.headers[0].name, "Header");
  assert.equal(table.rows[0].values["Header"], 2);
  assert.equal(table.rows[0].values.B, 4);
  assert.equal(table.rows[1].values["Header"], 6);
});

test("formula cache may be keyed by the formula expression", () => {
  const table = buildTableStructure(
    {
      rows: [
        [{ formula: "=A2*2" }, "B"],
        [4, 5],
      ],
      formulaCache: { "=A2*2": 8 },
    },
    { headerRows: 1 },
  );

  assert.equal(table.headers[0].name, "8");
  assert.equal(table.rows[0].values["8"], 4);
});

test("hidden rows and columns are omitted while coordinates stay physical", () => {
  const table = buildTableStructure(
    {
      rows: [
        ["A", "B", "C"],
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      hiddenRows: [2],
      hiddenColumns: [1],
    },
    { headerRows: 1 },
  );

  assert.deepEqual(table.rows.map((row) => row.rowIndex), [1, 3]);
  assert.deepEqual(table.rows.map((row) => row.values), [
    { A: 1, C: 3 },
    { A: 7, C: 9 },
  ]);
  assert.deepEqual(table.rows[0].cells.map((cell) => cell.columnIndex), [0, 2]);
  assert.equal(table.rows[0].cells[1].address, "C2");
});

test("supports zero-based merge objects and one-based A1 strings", () => {
  assert.deepEqual(rangeFromA1("$B$2:D4"), {
    startRow: 1,
    startColumn: 1,
    endRow: 3,
    endColumn: 3,
  });

  const table = buildTableStructure({
    rows: [
      ["Group", "Group"],
      ["A", "B"],
      [1, 2],
    ],
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }],
    headerRows: 2,
  });
  assert.deepEqual(table.headers.map((header) => header.key), [
    "Group / A",
    "Group / B",
  ]);
});

test("infers a two-row header from horizontal merges", () => {
  const table = buildTableStructure({
    rows: [
      ["Sales", null, "Profit", null],
      ["Q1", "Q2", "Q1", "Q2"],
      ["a", "b", "c", "d"],
    ],
    merges: ["A1:B1", "C1:D1"],
  });

  assert.deepEqual(table.headerRows, [0, 1]);
  assert.equal(table.dataStartRow, 2);
  assert.deepEqual(table.headers.map((header) => header.path), [
    ["Sales", "Q1"],
    ["Sales", "Q2"],
    ["Profit", "Q1"],
    ["Profit", "Q2"],
  ]);
});

test("can import without a header row", () => {
  const table = buildTableStructure(
    {
      rows: [
        [1, 2],
        [3, 4],
      ],
    },
    { hasHeader: false },
  );

  assert.deepEqual(table.headers.map((header) => header.key), [
    "Column A",
    "Column B",
  ]);
  assert.deepEqual(table.rows.map((row) => row.rowIndex), [0, 1]);
});

test("accepts a sheet-like object with hidden column metadata", () => {
  const table = buildTableStructure({
    rows: [
      [{ v: "Name" }, { v: "Age" }],
      [{ v: "Ada" }, { v: 36 }],
    ],
    "!cols": [{}, { hidden: true }],
  });

  assert.deepEqual(table.hiddenColumns, [1]);
  assert.deepEqual(table.rows[0].values, { Name: "Ada" });
});
