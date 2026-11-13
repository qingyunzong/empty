import {
  cellAddress,
  isRecord,
  normalizeHidden,
  normalizeRange,
  rangeAddress,
  rangesOverlap,
  rangeFromA1,
  validRange,
} from "./cells.ts";
import type {
  FormulaCacheInput,
  HiddenInput,
  ImportOptions,
  NormalizedRange,
  RangeInput,
  RowInput,
  WorksheetInput,
} from "./types.ts";

export class MergedRangeOverlapError extends RangeError {
  readonly ranges: readonly NormalizedRange[];

  constructor(ranges: readonly NormalizedRange[]) {
    const addresses = ranges.map(rangeAddress).join(" and ");
    super(`Merged ranges overlap: ${addresses}`);
    this.name = "MergedRangeOverlapError";
    this.ranges = ranges;
  }
}

export interface NormalizedWorksheet {
  readonly cells: readonly (readonly unknown[])[];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly hiddenRows: ReadonlySet<number>;
  readonly hiddenColumns: ReadonlySet<number>;
  readonly merges: readonly NormalizedRange[];
  readonly formulaCache: FormulaCacheInput | undefined;
  readonly headerStartRow: number | undefined;
  readonly headerRows: number | readonly number[] | undefined;
  readonly dataStartRow: number | undefined;
}

function rowToCells(row: RowInput): { cells: readonly unknown[]; hidden: boolean } {
  if (Array.isArray(row)) {
    return { cells: row, hidden: false };
  }
  if (!isRecord(row)) {
    return { cells: [row], hidden: false };
  }

  const hidden = row.hidden === true;
  const source =
    row.cells ?? row.values ?? row.data;
  if (Array.isArray(source)) {
    return { cells: source, hidden };
  }

  if (isRecord(source)) {
    return { cells: objectToCells(source), hidden };
  }

  const numericKeys = Object.keys(row).filter((key) => /^\d+$/.test(key));
  if (numericKeys.length > 0) {
    const max = Math.max(...numericKeys.map((key) => Number.parseInt(key, 10)));
    const cells = new Array<unknown>(max + 1).fill(null);
    for (const key of numericKeys) {
      cells[Number.parseInt(key, 10)] = row[key];
    }
    return { cells, hidden };
  }

  const letterKeys = Object.keys(row).filter((key) =>
    /^[A-Za-z]{1,4}$/.test(key),
  );
  if (letterKeys.length > 0) {
    const cells = new Map<number, unknown>();
    for (const key of letterKeys) {
      const column = letterToColumnLocal(key);
      cells.set(column, row[key]);
    }
    if (cells.size > 0) {
      const max = Math.max(...cells.keys());
      const result = new Array<unknown>(max + 1).fill(null);
      for (const [column, value] of cells) {
        result[column] = value;
      }
      return { cells: result, hidden };
    }
  }

  // A row object containing a single cell value is still a useful escape hatch.
  if (typeof source === "object" && source !== null) {
    return { cells: [source], hidden };
  }
  return { cells: [], hidden };
}

function letterToColumnLocal(letters: string): number {
  let column = 0;
  for (const character of letters.toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return column - 1;
}

function objectToCells(source: Record<string, unknown>): readonly unknown[] {
  const addressValues: { row: number; column: number; value: unknown }[] = [];
  let maxRow = -1;
  let maxColumn = -1;
  const numericRows = new Map<number, unknown>();
  const letterColumns = new Map<number, unknown>();

  for (const [key, value] of Object.entries(source)) {
    if (/^[A-Za-z]{1,4}\d+$/.test(key)) {
      try {
        const range = rangeFromA1(key);
        addressValues.push({
          row: range.startRow,
          column: range.startColumn,
          value,
        });
        maxRow = Math.max(maxRow, range.startRow);
        maxColumn = Math.max(maxColumn, range.startColumn);
        continue;
      } catch {
        // Fall through to the other supported map forms.
      }
    }
    if (/^\d+$/.test(key)) {
      const row = Number.parseInt(key, 10);
      numericRows.set(row, value);
      maxRow = Math.max(maxRow, row);
      continue;
    }
    if (/^[A-Za-z]{1,4}$/.test(key)) {
      const column = letterToColumnLocal(key);
      letterColumns.set(column, value);
      maxColumn = Math.max(maxColumn, column);
    }
  }

  if (maxRow < 0 && maxColumn < 0) {
    return [];
  }
  if (addressValues.length > 0) {
    const cells: unknown[][] = Array.from({ length: maxRow + 1 }, () =>
      new Array<unknown>(maxColumn + 1).fill(null),
    );
    for (const entry of addressValues) {
      cells[entry.row][entry.column] = entry.value;
    }
    return cells;
  }

  if (numericRows.size > 0) {
    const cells = new Array<unknown>(maxRow + 1);
    for (const [row, value] of numericRows) {
      cells[row] = value;
    }
    return cells;
  }

  const cells = new Array<unknown>(maxColumn + 1).fill(null);
  for (const [column, value] of letterColumns) {
    cells[column] = value;
  }
  return cells;
}

function looksLikeSparseCellList(
  source: readonly unknown[],
): source is readonly Record<string, unknown>[] {
  if (source.length === 0) {
    return false;
  }
  return source.every((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    if (
      Array.isArray(entry.cells) ||
      Array.isArray(entry.values) ||
      Array.isArray(entry.data)
    ) {
      return false;
    }
    const row =
      entry.rowIndex ?? entry.row ?? entry.r;
    const column =
      entry.columnIndex ?? entry.column ?? entry.col ?? entry.c ?? entry.c;
    return (
      typeof row === "number" &&
      Number.isInteger(row) &&
      typeof column === "number" &&
      Number.isInteger(column)
    );
  });
}

function sparseCellsToGrid(
  entries: readonly Record<string, unknown>[],
): { cells: unknown[][]; rowCount: number; columnCount: number } {
  let maxRow = -1;
  let maxColumn = -1;
  const values: { row: number; column: number; value: unknown }[] = [];

  for (const entry of entries) {
    const row = (entry.rowIndex ?? entry.row ?? entry.r) as number;
    const column = (entry.columnIndex ??
      entry.column ??
      entry.col ??
      entry.c) as number;
    values.push({
      row,
      column,
      value: entry,
    });
    maxRow = Math.max(maxRow, row);
    maxColumn = Math.max(maxColumn, column);
  }

  const cells: unknown[][] = Array.from({ length: maxRow + 1 }, () =>
    new Array<unknown>(maxColumn + 1).fill(null),
  );
  for (const entry of values) {
    cells[entry.row][entry.column] = entry.value;
  }
  return {
    cells,
    rowCount: maxRow + 1,
    columnCount: maxColumn + 1,
  };
}

interface RowGrid {
  readonly cells: readonly unknown[][];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly hiddenRows: Set<number>;
}

function normalizeRows(source: unknown): RowGrid {
  if (source === undefined || source === null) {
    return { cells: [], rowCount: 0, columnCount: 0, hiddenRows: new Set() };
  }
  if (source instanceof Map) {
    const object: Record<string, unknown> = {};
    for (const [key, value] of source) {
      object[String(key)] = value;
    }
    return normalizeRows(object);
  }

  let rows: readonly unknown[];
  if (Array.isArray(source)) {
    if (looksLikeSparseCellList(source)) {
      const grid = sparseCellsToGrid(source);
      return { ...grid, hiddenRows: new Set() };
    }
    rows = source;
  } else if (isRecord(source)) {
    const keys = Object.keys(source);
    const numericKeys = keys.filter((key) => /^\d+$/.test(key));
    const addressKeys = keys.filter((key) =>
      /^[A-Za-z]{1,4}\d+$/.test(key),
    );
    if (addressKeys.length > 0) {
      const cells = objectToCells(source) as unknown[][];
      return {
        cells,
        rowCount: cells.length,
        columnCount: cells.reduce(
          (width, row) => Math.max(width, row.length),
          0,
        ),
        hiddenRows: new Set(),
      };
    }
    if (numericKeys.length === keys.length && numericKeys.length > 0) {
      const max = Math.max(
        ...numericKeys.map((key) => Number.parseInt(key, 10)),
      );
      const sparseRows = new Array<unknown>(max + 1);
      for (const key of numericKeys) {
        sparseRows[Number.parseInt(key, 10)] = source[key];
      }
      rows = sparseRows;
    } else {
      const converted = objectToCells(source);
      return {
        cells: [[...converted]],
        rowCount: 1,
        columnCount: converted.length,
        hiddenRows: new Set(),
      };
    }
  } else {
    throw new TypeError("Worksheet rows must be a 2D array or row map");
  }

  const hiddenRows = new Set<number>();
  let columnCount = 0;
  const normalized: unknown[][] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const result =
      row === undefined || row === null
        ? { cells: [] as readonly unknown[], hidden: false }
        : rowToCells(row as RowInput);
    if (result.hidden) {
      hiddenRows.add(index);
    }
    columnCount = Math.max(columnCount, result.cells.length);
    normalized.push([...result.cells]);
  }

  for (const row of normalized) {
    while (row.length < columnCount) {
      row.push(null);
    }
  }

  return {
    cells: normalized,
    rowCount: normalized.length,
    columnCount,
    hiddenRows,
  };
}

function worksheetBounds(input: WorksheetInput): {
  rowCount: number;
  columnCount: number;
} {
  const dimension =
    input["!ref"] ?? input.range ?? input.dimension;
  let rowCount = 0;
  let columnCount = 0;
  if (typeof dimension === "string") {
    try {
      const range = rangeFromA1(dimension);
      rowCount = range.endRow + 1;
      columnCount = range.endColumn + 1;
    } catch {
      // Ignore malformed dimension metadata.
    }
  }
  if (typeof input.rowCount === "number" && input.rowCount > rowCount) {
    rowCount = input.rowCount;
  }
  const width = input.columnCount ?? input.width;
  if (typeof width === "number" && width > columnCount) {
    columnCount = width;
  }
  return { rowCount, columnCount };
}

function rowMetadataHidden(input: WorksheetInput): Set<number> {
  const result = new Set<number>();
  const rows = input["!rows"];
  if (Array.isArray(rows)) {
    rows.forEach((row, index) => {
      if (isRecord(row) && row.hidden === true) {
        result.add(index);
      }
    });
  }
  return result;
}

function columnMetadataHidden(input: WorksheetInput): Set<number> {
  const result = new Set<number>();
  const columns = input["!cols"];
  if (Array.isArray(columns)) {
    columns.forEach((column, index) => {
      if (isRecord(column) && column.hidden === true) {
        result.add(index);
      }
    });
  }
  return result;
}

function mergeInputs(input: WorksheetInput): readonly RangeInput[] {
  return (
    input.mergedRanges ??
    input.merges ??
    input.mergedCells ??
    input.mergeRanges ??
    input["!merges"] ??
    []
  );
}

function normalizeMerges(input: WorksheetInput): NormalizedRange[] {
  const inputs = mergeInputs(input);
  const ranges = inputs.map((range) => normalizeRange(range));
  for (let index = 0; index < ranges.length; index += 1) {
    validRange(ranges[index], inputs[index]);
    for (let other = 0; other < index; other += 1) {
      if (rangesOverlap(ranges[index], ranges[other])) {
        throw new MergedRangeOverlapError([ranges[other], ranges[index]]);
      }
    }
  }
  return ranges;
}

function sourceRows(input: WorksheetInput): unknown {
  if (input.rows !== undefined) {
    return input.rows;
  }
  if (input.cells !== undefined) {
    return input.cells;
  }
  if (input.values !== undefined) {
    return input.values;
  }
  if (input.data !== undefined) {
    return input.data;
  }
  if (input.grid !== undefined) {
    return input.grid;
  }
  if (input.matrix !== undefined) {
    return input.matrix;
  }

  // SheetJS and several parsers expose cells directly on the worksheet object
  // as `{ A1: cell, B1: cell, ... }`.
  const addressKeys = Object.keys(input).filter((key) =>
    /^[A-Za-z]{1,4}\d+$/.test(key),
  );
  if (addressKeys.length > 0) {
    return input;
  }
  return undefined;
}

function optionHidden(
  override: HiddenInput | undefined,
  fromWorksheet: HiddenInput | undefined,
  kind: "row" | "column",
): Set<number> {
  return normalizeHidden(override ?? fromWorksheet, kind);
}

/**
 * Normalizes a worksheet-like object into a rectangular physical grid.
 * Leading/trailing coordinates are never discarded: hidden rows and columns
 * are represented separately and every cell keeps its physical row/column.
 */
export function normalizeWorksheet(
  input: WorksheetInput,
  options: ImportOptions,
): NormalizedWorksheet {
  if (!isRecord(input)) {
    throw new TypeError("Worksheet input must be an object or a 2D cell array");
  }

  const rowGrid = normalizeRows(sourceRows(input));
  const bounds = worksheetBounds(input);
  const merges = normalizeMerges(input);

  let rowCount = Math.max(rowGrid.rowCount, bounds.rowCount);
  let columnCount = Math.max(rowGrid.columnCount, bounds.columnCount);
  for (const merge of merges) {
    rowCount = Math.max(rowCount, merge.endRow + 1);
    columnCount = Math.max(columnCount, merge.endColumn + 1);
  }

  const cells: unknown[][] = Array.from({ length: rowCount }, (_, rowIndex) => {
    const row = rowGrid.cells[rowIndex] ?? [];
    const result = new Array<unknown>(columnCount).fill(null);
    for (let column = 0; column < Math.min(row.length, columnCount); column += 1) {
      if (row[column] !== undefined) {
        result[column] = row[column];
      }
    }
    return result;
  });

  const hiddenRows = optionHidden(
    options.hiddenRows,
    input.hiddenRows ??
      input.hiddenRowIndexes ??
      input.hiddenRowIndices ??
      input.hiddenRowsIndexes ??
      input.hidden?.rows,
    "row",
  );
  const hiddenColumns = optionHidden(
    options.hiddenColumns,
    input.hiddenColumns ??
      input.hiddenColumnIndexes ??
      input.hiddenColumnIndices ??
      input.hiddenCols ??
      input.hidden?.columns ??
      input.hidden?.cols,
    "column",
  );
  for (const row of rowGrid.hiddenRows) {
    hiddenRows.add(row);
  }
  for (const row of rowMetadataHidden(input)) {
    hiddenRows.add(row);
  }
  for (const column of columnMetadataHidden(input)) {
    hiddenColumns.add(column);
  }

  const formulaCache = options.formulaCache ??
    input.formulaCache ??
    input.formulaValues ??
    input.cachedValues ??
    input.cache;

  return {
    cells,
    rowCount,
    columnCount,
    hiddenRows,
    hiddenColumns,
    merges,
    formulaCache,
    headerStartRow: options.headerStartRow ?? input.headerStartRow,
    headerRows: options.headerRows ??
      options.headerRowCount ??
      options.headerDepth ??
      input.headerRows ??
      input.headerRowCount ??
      input.headerDepth,
    dataStartRow: options.dataStartRow ??
      options.firstDataRow ??
      input.dataStartRow ??
      input.firstDataRow,
  };
}

export function rawCellAddress(row: number, column: number): string {
  return cellAddress(row, column);
}
