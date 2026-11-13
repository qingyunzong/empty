import { isEmptyValue, resolveCellValue } from "./cells.ts";
import { buildHeaders, visibleRows } from "./header.ts";
import type {
  ImportOptions,
  ImportedCell,
  RowInput,
  TableRow,
  TableStructure,
  WorksheetInput,
} from "./types.ts";
import { normalizeWorksheet } from "./worksheet.ts";

export type WorksheetOrRows = WorksheetInput | readonly RowInput[];

function asWorksheetInput(input: WorksheetOrRows): WorksheetInput {
  if (Array.isArray(input)) {
    return { rows: input };
  }
  return input as WorksheetInput;
}

function setRecordValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Builds a rectangular table description from a worksheet parser result.
 *
 * - Merged ranges are validated first; any overlap throws
 *   `MergedRangeOverlapError`.
 * - Header labels are expanded only inside the merged range that owns them.
 * - Hidden rows/columns are excluded from headers/data but all coordinates in
 *   the result remain the original physical coordinates.
 * - Duplicate leaf labels are distinguished by the complete `path`/`key`.
 * - Formula cells resolve to cached results, never formula text.
 */
export function buildTableStructure(
  input: WorksheetOrRows,
  options: ImportOptions = {},
): TableStructure {
  const worksheet = normalizeWorksheet(asWorksheetInput(input), options);
  const headerResult = buildHeaders(worksheet, options);
  const dataStartRow = worksheet.dataStartRow ?? headerResult.dataStartRow;
  const visible = visibleRows(
    worksheet.rowCount,
    worksheet.hiddenRows,
    options.includeHiddenRows === true,
  );
  const skipEmptyRows = options.skipEmptyRows !== false;
  const rows: TableRow[] = [];

  for (const rowIndex of visible) {
    if (rowIndex < dataStartRow) {
      continue;
    }

    const values: Record<string, unknown> = {};
    const cells: ImportedCell[] = [];
    let isEmpty = true;

    for (const header of headerResult.headers) {
      const value = resolveCellValue(
        worksheet.cells[rowIndex]?.[header.columnIndex],
        rowIndex,
        header.columnIndex,
        worksheet.formulaCache,
      );
      if (!isEmptyValue(value)) {
        isEmpty = false;
      }
      setRecordValue(values, header.key, value);
      cells.push({
        key: header.key,
        path: header.path,
        name: header.name,
        rowIndex,
        row: rowIndex + 1,
        columnIndex: header.columnIndex,
        sourceColumn: header.columnIndex,
        originalColumnIndex: header.columnIndex,
        column: header.columnIndex + 1,
        address: `${header.letter}${rowIndex + 1}`,
        value,
      });
    }

    if (skipEmptyRows && isEmpty) {
      continue;
    }

    rows.push({
      rowIndex,
      sourceRow: rowIndex,
      originalRowIndex: rowIndex,
      row: rowIndex + 1,
      values,
      record: values,
      cells,
      isEmpty,
    });
  }

  return {
    headers: headerResult.headers,
    columns: headerResult.headers,
    rows,
    data: rows,
    headerRows: headerResult.headerRows,
    headerRowIndices: headerResult.headerRows,
    headerRange: headerResult.headerRange,
    dataStartRow,
    hiddenRows: [...worksheet.hiddenRows].sort((left, right) => left - right),
    hiddenColumns: [...worksheet.hiddenColumns].sort((left, right) => left - right),
    merges: worksheet.merges,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    headerDepth: headerResult.headerDepth,
    headerTree: headerResult.headerTree,
  };
}

export const importWorksheet = buildTableStructure;
export const parseWorksheet = buildTableStructure;
export const buildTable = buildTableStructure;
export const parseTable = buildTableStructure;
export const createTableStructure = buildTableStructure;
export const importTable = buildTableStructure;
export const importWorksheetTable = buildTableStructure;
export const parseWorksheetTable = buildTableStructure;
export const worksheetToTable = buildTableStructure;

/** Convenience: return only plain value records keyed by complete header path. */
export function tableToRecords(table: TableStructure): Record<string, unknown>[] {
  return table.rows.map((row) => ({ ...row.values }));
}

/** Looks a column up by complete path, its joined key, or its `id`. */
export function findColumn(
  table: TableStructure,
  pathOrKey: string | readonly string[],
): TableStructure["headers"][number] | undefined {
  if (typeof pathOrKey === "string") {
    return table.headers.find(
      (header) => header.key === pathOrKey || header.id === pathOrKey,
    );
  }
  const identity = JSON.stringify(pathOrKey);
  return table.headers.find(
    (header) =>
      header.id === identity ||
      (header.path.length === pathOrKey.length &&
        header.path.every((value, index) => value === pathOrKey[index])),
  );
}

/** Reads a value by complete path; safe for duplicate leaf names. */
export function readCell(
  table: TableStructure,
  rowIndex: number,
  pathOrKey: string | readonly string[],
): unknown {
  const row = table.rows.find((candidate) => candidate.rowIndex === rowIndex);
  if (!row) {
    return undefined;
  }
  const column = findColumn(table, pathOrKey);
  return column ? row.values[column.key] : undefined;
}

export class WorksheetTableImporter {
  readonly options: ImportOptions;

  constructor(options: ImportOptions = {}) {
    this.options = options;
  }

  import(input: WorksheetOrRows, options: ImportOptions = {}): TableStructure {
    return buildTableStructure(input, { ...this.options, ...options });
  }

  parse(input: WorksheetOrRows, options: ImportOptions = {}): TableStructure {
    return this.import(input, options);
  }
}

export function createWorksheetImporter(
  options: ImportOptions = {},
): WorksheetTableImporter {
  return new WorksheetTableImporter(options);
}

export const TableImporter = WorksheetTableImporter;
