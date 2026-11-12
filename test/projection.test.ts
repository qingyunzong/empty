import test from "node:test";
import assert from "node:assert/strict";
import { compileProjection, type ColumnSpec } from "../src/compile.ts";
import { MISSING, projectRecord, type JsonValue, type ProjectionRow } from "../src/project.ts";
import { ProjectionError } from "../src/errors.ts";
import { referenceProject } from "./reference.ts";
import { deepFreeze, normalizeRows } from "./helpers.ts";

const cell = (value: JsonValue, path: string) => ({ value, path });
const missing = (path: string) => ({ value: MISSING, path });

function assertCode(fn: () => unknown, code: ProjectionError["code"]): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ProjectionError, `expected ProjectionError, got ${error}`);
    assert.equal((error as ProjectionError).code, code);
    return true;
  });
}

function assertMatchesReference(
  columns: readonly ColumnSpec[],
  record: JsonValue,
  maxRows?: number,
): void {
  const compiled = compileProjection(columns);
  const run = (fn: () => ProjectionRow[]): { rows?: unknown; code?: string } => {
    try {
      return { rows: normalizeRows(fn()) };
    } catch (error) {
      return { code: (error as ProjectionError).code };
    }
  };
  const main = run(() => projectRecord(compiled, record, maxRows === undefined ? {} : { maxRows }));
  const reference = run(() => referenceProject(columns, record, maxRows));
  assert.deepStrictEqual(main, reference);
}

test("related fields sharing one array node align by element position", () => {
  const columns = [
    { name: "id", path: "items[*].id" },
    { name: "qty", path: "items[*].qty" },
  ];
  const record = { items: [{ id: 1, qty: 10 }, { id: 2, qty: 20 }] };
  const rows = projectRecord(compileProjection(columns), record);
  // Shared prefix `items[*]` expands once: 2 rows, not 2x2.
  assert.deepStrictEqual(rows, [
    { id: cell(1, "items[0].id"), qty: cell(10, "items[0].qty") },
    { id: cell(2, "items[1].id"), qty: cell(20, "items[1].qty") },
  ]);
  assertMatchesReference(columns, record);
});

test("independent arrays produce a cartesian product", () => {
  const columns = [
    { name: "a", path: "a[*]" },
    { name: "b", path: "b[*]" },
  ];
  const record = { a: [1, 2], b: ["x", "y", "z"] };
  const rows = projectRecord(compileProjection(columns), record);
  assert.deepStrictEqual(rows, [
    { a: cell(1, "a[0]"), b: cell("x", "b[0]") },
    { a: cell(1, "a[0]"), b: cell("y", "b[1]") },
    { a: cell(1, "a[0]"), b: cell("z", "b[2]") },
    { a: cell(2, "a[1]"), b: cell("x", "b[0]") },
    { a: cell(2, "a[1]"), b: cell("y", "b[1]") },
    { a: cell(2, "a[1]"), b: cell("z", "b[2]") },
  ]);
  assertMatchesReference(columns, record);
});

test("nested empty arrays keep one placeholder row that stays aligned", () => {
  const columns = [
    { name: "name", path: "outer[*].name" },
    { name: "v", path: "outer[*].inner[*].v" },
  ];
  const record = {
    outer: [
      { name: "n1", inner: [] },
      { name: "n2", inner: [{ v: 7 }] },
    ],
  };
  const rows = projectRecord(compileProjection(columns), record);
  assert.deepStrictEqual(rows, [
    { name: cell("n1", "outer[0].name"), v: missing("outer[0].inner[*].v") },
    { name: cell("n2", "outer[1].name"), v: cell(7, "outer[1].inner[0].v") },
  ]);
  assertMatchesReference(columns, record);
});

test("empty root-level array yields one row of missing cells", () => {
  const columns = [
    { name: "x", path: "a[*].x" },
    { name: "y", path: "a[*].y" },
  ];
  const record = { a: [] };
  const rows = projectRecord(compileProjection(columns), record);
  assert.deepStrictEqual(rows, [{ x: missing("a[*].x"), y: missing("a[*].y") }]);
  assertMatchesReference(columns, record);
});

test("row limit: exactly at the limit succeeds, one less rejects the record", () => {
  const columns = [
    { name: "a", path: "a[*]" },
    { name: "b", path: "b[*]" },
  ];
  const record = { a: [1, 2], b: ["x", "y", "z"] };
  const compiled = compileProjection(columns);
  const rows = projectRecord(compiled, record, { maxRows: 6 });
  assert.equal(rows.length, 6);
  // Over the limit: the record is rejected, no partial rows are delivered.
  assertCode(() => projectRecord(compiled, record, { maxRows: 5 }), "ROW_LIMIT_EXCEEDED");
  assertCode(() => projectRecord(compiled, record, { maxRows: 0 }), "ROW_LIMIT_EXCEEDED");
  assertMatchesReference(columns, record, 6);
  assertMatchesReference(columns, record, 5);
});

test("missing fields and explicit null are distinct", () => {
  const columns = [
    { name: "present", path: "present" },
    { name: "absent", path: "absent" },
  ];
  const record = { present: null };
  const rows = projectRecord(compileProjection(columns), record);
  assert.equal(rows.length, 1);
  assert.strictEqual(rows[0].present.value, null);
  assert.strictEqual(rows[0].present.path, "present");
  assert.strictEqual(rows[0].absent.value, MISSING);
  assert.notStrictEqual(rows[0].absent.value, rows[0].present.value);
  assertMatchesReference(columns, record);
});

test("placeholders from missing paths participate in alignment", () => {
  const columns = [
    { name: "id", path: "items[*].id" },
    { name: "tag", path: "items[*].tags[*]" },
    { name: "note", path: "items[*].note" },
  ];
  const record: JsonValue = {
    items: [
      { id: 1, tags: [] },
      { id: 2, tags: ["x", "y"], note: "n" },
      { id: 3 },
    ],
  };
  const rows = projectRecord(compileProjection(columns), record);
  assert.deepStrictEqual(rows, [
    { id: cell(1, "items[0].id"), tag: missing("items[0].tags[*]"), note: missing("items[0].note") },
    { id: cell(2, "items[1].id"), tag: cell("x", "items[1].tags[0]"), note: cell("n", "items[1].note") },
    { id: cell(2, "items[1].id"), tag: cell("y", "items[1].tags[1]"), note: cell("n", "items[1].note") },
    { id: cell(3, "items[2].id"), tag: missing("items[2].tags[*]"), note: missing("items[2].note") },
  ]);
  assertMatchesReference(columns, record);
});

test("nested arrays flatten, ragged lengths included", () => {
  const columns = [{ name: "v", path: "outer[*].inner[*]" }];
  const record = { outer: [{ inner: [1, 2] }, { inner: [3] }] };
  const rows = projectRecord(compileProjection(columns), record);
  assert.deepStrictEqual(rows, [
    { v: cell(1, "outer[0].inner[0]") },
    { v: cell(2, "outer[0].inner[1]") },
    { v: cell(3, "outer[1].inner[0]") },
  ]);
  assertMatchesReference(columns, record);
});

test("type mismatches reject the record", () => {
  const cases: Array<{ columns: ColumnSpec[]; record: JsonValue }> = [
    { columns: [{ name: "c", path: "a[*]" }], record: { a: 5 } },
    { columns: [{ name: "c", path: "a[*]" }], record: { a: {} } },
    { columns: [{ name: "c", path: "a[*]" }], record: { a: null } },
    { columns: [{ name: "c", path: "a.b" }], record: { a: 5 } },
    { columns: [{ name: "c", path: "a.b" }], record: { a: [] } },
    { columns: [{ name: "c", path: "a.b" }], record: { a: null } },
    { columns: [{ name: "c", path: "a[*].b" }], record: { a: [1, 2] } },
    { columns: [{ name: "c", path: "a" }], record: 5 },
    { columns: [{ name: "c", path: "[*]" }], record: { notArray: true } },
  ];
  for (const { columns, record } of cases) {
    const compiled = compileProjection(columns);
    assertCode(() => projectRecord(compiled, record), "TYPE_MISMATCH");
    assertMatchesReference(columns, record);
  }
});

test("compile-time validation of columns and paths", () => {
  assertCode(
    () =>
      compileProjection([
        { name: "dup", path: "a" },
        { name: "dup", path: "b" },
      ]),
    "DUPLICATE_COLUMN",
  );
  assertCode(() => compileProjection([{ name: "", path: "a" }]), "INVALID_COLUMN");
  for (const path of ["", ".", "a..b", "a.", ".a", "a[", "a[x]", "[", "[*"]) {
    assertCode(() => compileProjection([{ name: "c", path }]), "INVALID_PATH");
  }
  // Identical paths under different column names are allowed.
  const compiled = compileProjection([
    { name: "c1", path: "a[*]" },
    { name: "c2", path: "a[*]" },
  ]);
  assert.deepStrictEqual(projectRecord(compiled, { a: [1] }), [
    { c1: cell(1, "a[0]"), c2: cell(1, "a[0]") },
  ]);
});

test("invalid maxRows option is rejected", () => {
  const compiled = compileProjection([{ name: "c", path: "a" }]);
  for (const maxRows of [-1, 1.5, Number.NaN]) {
    assertCode(() => projectRecord(compiled, { a: 1 }, { maxRows }), "INVALID_OPTION");
  }
});

test("input record is not mutated", () => {
  const columns = [
    { name: "id", path: "items[*].id" },
    { name: "tag", path: "items[*].tags[*]" },
  ];
  const record: JsonValue = { items: [{ id: 1, tags: ["x"] }, { id: 2 }] };
  const snapshot = JSON.stringify(record);
  const rows = projectRecord(compileProjection(columns), deepFreeze(record));
  assert.equal(rows.length, 2);
  assert.equal(JSON.stringify(record), snapshot);
});

test("curated scenarios agree with the explicit-enumeration reference", () => {
  const scenarios: Array<{ columns: ColumnSpec[]; record: JsonValue; maxRows?: number }> = [
    {
      columns: [
        { name: "id", path: "items[*].id" },
        { name: "qty", path: "items[*].qty" },
      ],
      record: { items: [{ id: 1, qty: 10 }, { id: 2, qty: 20 }] },
    },
    {
      columns: [
        { name: "a", path: "a[*]" },
        { name: "b", path: "b[*]" },
      ],
      record: { a: [1, 2], b: ["x", "y", "z"] },
      maxRows: 6,
    },
    {
      columns: [
        { name: "name", path: "outer[*].name" },
        { name: "v", path: "outer[*].inner[*].v" },
      ],
      record: { outer: [{ name: "n1", inner: [] }, { name: "n2", inner: [{ v: 7 }] }] },
    },
    {
      columns: [
        { name: "x", path: "a[*].x" },
        { name: "y", path: "a[*].y" },
      ],
      record: { a: [] },
    },
    {
      columns: [
        { name: "p", path: "present" },
        { name: "q", path: "absent" },
      ],
      record: { present: null },
    },
    {
      columns: [
        { name: "v", path: "outer[*].inner[*]" },
        { name: "w", path: "other[*]" },
      ],
      record: { outer: [{ inner: [1, 2] }, { inner: [] }], other: ["a"] },
    },
    {
      columns: [
        { name: "c1", path: "a[*]" },
        { name: "c2", path: "a[*]" },
      ],
      record: { a: [null, 1] },
    },
    { columns: [], record: { a: 1 } },
    {
      columns: [
        { name: "deep", path: "a[*].b[*].c" },
        { name: "sib", path: "a[*].d" },
        { name: "top", path: "e[*]" },
      ],
      record: {
        a: [
          { b: [{ c: 1 }, { c: null }], d: "x" },
          { b: [], d: "y" },
        ],
        e: [true, false],
      },
      maxRows: 16,
    },
  ];
  for (const { columns, record, maxRows } of scenarios) {
    assertMatchesReference(columns, record, maxRows);
  }
});
