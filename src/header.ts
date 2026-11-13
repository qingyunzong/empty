import {
  cellAddress,
  columnToLetter,
  headerLabel,
  isEmptyValue,
  resolveCellValue,
} from "./cells.ts";
import type { NormalizedWorksheet } from "./worksheet.ts";
import type {
  HeaderCellReference,
  HeaderColumn,
  HeaderNode,
  ImportOptions,
  NormalizedRange,
} from "./types.ts";

interface HeaderSelection {
  readonly rows: readonly number[];
  readonly range: NormalizedRange | null;
  readonly dataStartRow: number;
}

export interface HeaderBuildResult {
  readonly headers: readonly HeaderColumn[];
  readonly headerRows: readonly number[];
  readonly headerRange: NormalizedRange | null;
  readonly dataStartRow: number;
  readonly headerDepth: number;
  readonly headerTree: readonly HeaderNode[];
}

export function visibleRows(
  rowCount: number,
  hidden: ReadonlySet<number>,
  includeHidden: boolean,
): number[] {
  const rows: number[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    if (includeHidden || !hidden.has(row)) {
      rows.push(row);
    }
  }
  return rows;
}

export function visibleColumns(
  columnCount: number,
  hidden: ReadonlySet<number>,
  includeHidden: boolean,
): number[] {
  const columns: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    if (includeHidden || !hidden.has(column)) {
      columns.push(column);
    }
  }
  return columns;
}

function cellValue(worksheet: NormalizedWorksheet, row: number, column: number): unknown {
  return resolveCellValue(
    worksheet.cells[row]?.[column],
    row,
    column,
    worksheet.formulaCache,
  );
}

function rowHasValue(worksheet: NormalizedWorksheet, row: number): boolean {
  if (row < 0 || row >= worksheet.rowCount) {
    return false;
  }
  for (let column = 0; column < worksheet.columnCount; column += 1) {
    if (!isEmptyValue(cellValue(worksheet, row, column))) {
      return true;
    }
  }
  return false;
}

function firstVisibleContentRow(
  worksheet: NormalizedWorksheet,
  rows: readonly number[],
): number | null {
  for (const row of rows) {
    if (rowHasValue(worksheet, row)) {
      return row;
    }
  }
  return null;
}

function rangeKey(range: NormalizedRange): string {
  return `${range.startRow},${range.startColumn},${range.endRow},${range.endColumn}`;
}

function rowLooksLikeData(
  worksheet: NormalizedWorksheet,
  row: number,
  columns: readonly number[],
  merges: readonly NormalizedRange[],
): boolean {
  if (row < 0 || row >= worksheet.rowCount) {
    return false;
  }
  let nonEmpty = 0;
  let numeric = 0;
  for (const column of columns) {
    const covered = merges.some(
      (merge) =>
        merge.startRow <= row &&
        row <= merge.endRow &&
        merge.startColumn <= column &&
        column <= merge.endColumn,
    );
    if (covered) {
      continue;
    }
    const value = cellValue(worksheet, row, column);
    if (isEmptyValue(value)) {
      continue;
    }
    nonEmpty += 1;
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value instanceof Date
    ) {
      numeric += 1;
    } else if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      numeric += 1;
    }
  }
  return nonEmpty > 0 && numeric === nonEmpty;
}

/**
 * Determines the physical header extent. When no explicit count is supplied,
 * merged ranges touching the first content row drive the depth. A horizontal
 * merge adds a child-header row unless the following row clearly looks like
 * numeric/date data.
 */
function selectHeaderRows(
  worksheet: NormalizedWorksheet,
  options: ImportOptions,
): HeaderSelection {
  if (options.hasHeader === false) {
    return { rows: [], range: null, dataStartRow: 0 };
  }

  const visible = visibleRows(
    worksheet.rowCount,
    worksheet.hiddenRows,
    false,
  );
  const requested = worksheet.headerRows;
  if (Array.isArray(requested)) {
    const rows = [...new Set(requested)]
      .filter(
        (row) =>
          Number.isInteger(row) &&
          row >= 0 &&
          row < worksheet.rowCount &&
          !worksheet.hiddenRows.has(row),
      )
      .sort((left, right) => left - right);
    if (rows.length === 0) {
      return { rows: [], range: null, dataStartRow: worksheet.dataStartRow ?? 0 };
    }
    return {
      rows,
      range: {
        startRow: rows[0],
        startColumn: 0,
        endRow: rows[rows.length - 1],
        endColumn: Math.max(0, worksheet.columnCount - 1),
      },
      dataStartRow: rows[rows.length - 1] + 1,
    };
  }

  let start: number | null =
    worksheet.headerStartRow !== undefined
      ? worksheet.headerStartRow
      : null;
  if (start === null || !Number.isInteger(start) || start < 0) {
    start = firstVisibleContentRow(worksheet, visible);
  }
  if (start === null && typeof requested === "number" && requested > 0) {
    start = 0;
  }
  if (start === null || start >= worksheet.rowCount) {
    return { rows: [], range: null, dataStartRow: worksheet.dataStartRow ?? 0 };
  }

  if (typeof requested === "number") {
    if (requested <= 0) {
      return {
        rows: [],
        range: null,
        dataStartRow: worksheet.dataStartRow ?? start,
      };
    }
    const end = Math.min(worksheet.rowCount - 1, start + requested - 1);
    const rows = visible.filter((row) => row >= start && row <= end);
    return {
      rows,
      range: rows.length
        ? {
            startRow: start,
            startColumn: 0,
            endRow: end,
            endColumn: Math.max(0, worksheet.columnCount - 1),
          }
        : null,
      dataStartRow: end + 1,
    };
  }

  // No explicit header count: use merges that touch the first content row as
  // the top of a header band, then include merges nested inside that band.
  const touching = worksheet.merges.filter(
    (merge) => merge.startRow <= start! && start! <= merge.endRow,
  );
  if (touching.length === 0) {
    return {
      rows: [start],
      range: {
        startRow: start,
        startColumn: 0,
        endRow: start,
        endColumn: Math.max(0, worksheet.columnCount - 1),
      },
      dataStartRow: start + 1,
    };
  }

  let end = start;
  for (const merge of touching) {
    end = Math.max(end, merge.endRow);
  }

  const columns = visibleColumns(
    worksheet.columnCount,
    worksheet.hiddenColumns,
    false,
  );
  const noDataAfter = worksheet.dataStartRow !== undefined;

  for (let pass = 0; pass < worksheet.rowCount; pass += 1) {
    let changed = false;

    for (const merge of worksheet.merges) {
      if (merge.startRow < start || merge.startRow > end) {
        continue;
      }
      if (merge.startRow > start && rowLooksLikeData(worksheet, merge.startRow, columns, worksheet.merges)) {
        continue;
      }
      if (merge.endRow > end) {
        end = merge.endRow;
        changed = true;
      }
    }

    if (!noDataAfter && end + 1 < worksheet.rowCount) {
      const horizontalAtBottom = worksheet.merges.some(
        (merge) =>
          merge.startRow === end &&
          merge.endRow === end &&
          merge.endColumn > merge.startColumn,
      );
      if (horizontalAtBottom) {
        const nextVisible = visible.find((row) => row > end);
        if (
          nextVisible !== undefined &&
          !rowLooksLikeData(worksheet, nextVisible, columns, worksheet.merges)
        ) {
          end = nextVisible;
          changed = true;
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  end = Math.min(end, worksheet.rowCount - 1);
  const rows = visible.filter((row) => row >= start! && row <= end);
  return {
    rows,
    range: {
      startRow: start,
      startColumn: 0,
      endRow: end,
      endColumn: Math.max(0, worksheet.columnCount - 1),
    },
    dataStartRow: end + 1,
  };
}

interface MergeMap {
  readonly byCell: ReadonlyMap<string, NormalizedRange>;
}

function buildMergeMap(
  worksheet: NormalizedWorksheet,
  headerRows: readonly number[],
): MergeMap {
  const byCell = new Map<string, NormalizedRange>();
  if (headerRows.length === 0) {
    return { byCell };
  }
  const rowSet = new Set(headerRows);
  for (const merge of worksheet.merges) {
    for (
      let row = merge.startRow;
      row <= merge.endRow && row < worksheet.rowCount;
      row += 1
    ) {
      if (!rowSet.has(row)) {
        continue;
      }
      for (
        let column = merge.startColumn;
        column <= merge.endColumn && column < worksheet.columnCount;
        column += 1
      ) {
        byCell.set(`${row},${column}`, merge);
      }
    }
  }
  return { byCell };
}

function mergeAnchorValue(
  worksheet: NormalizedWorksheet,
  merge: NormalizedRange,
): unknown {
  return cellValue(worksheet, merge.startRow, merge.startColumn);
}

function uniqueKey(
  base: string,
  used: Set<string>,
): { key: string; duplicate: boolean } {
  if (!used.has(base)) {
    used.add(base);
    return { key: base, duplicate: false };
  }
  let suffix = 2;
  while (used.has(`${base} #${suffix}`)) {
    suffix += 1;
  }
  const key = `${base} #${suffix}`;
  used.add(key);
  return { key, duplicate: true };
}

interface HeaderPathResult {
  readonly path: readonly string[];
  readonly levels: readonly (string | null)[];
  readonly headerCells: readonly HeaderCellReference[];
}

function buildHeaderPath(
  worksheet: NormalizedWorksheet,
  mergeMap: MergeMap,
  column: number,
  headerRows: readonly number[],
  trim: boolean,
): HeaderPathResult {
  const path: string[] = [];
  const levels: (string | null)[] = [];
  const headerCells: HeaderCellReference[] = [];
  let previousMerge: NormalizedRange | null = null;

  for (const headerRow of headerRows) {
    const merge = mergeMap.byCell.get(`${headerRow},${column}`);
    const isSameVerticalMerge =
      merge !== undefined &&
      previousMerge !== null &&
      rangeKey(merge) === rangeKey(previousMerge);

    previousMerge = merge ?? null;
    if (isSameVerticalMerge) {
      levels.push(null);
      continue;
    }

    const sourceRow = merge ? merge.startRow : headerRow;
    const sourceColumn = merge ? merge.startColumn : column;
    const value = merge
      ? mergeAnchorValue(worksheet, merge)
      : cellValue(worksheet, headerRow, column);
    const label = headerLabel(value, trim);
    if (label === "") {
      levels.push(null);
      continue;
    }

    path.push(label);
    levels.push(label);
    headerCells.push({
      rowIndex: sourceRow,
      row: sourceRow + 1,
      columnIndex: sourceColumn,
      column: sourceColumn + 1,
      address: cellAddress(sourceRow, sourceColumn),
      value,
      ...(merge ? { merge } : {}),
    });
  }

  return { path, levels, headerCells };
}

function buildHeaderTree(
  headers: readonly HeaderColumn[],
  separator: string,
): HeaderNode[] {
  const roots: HeaderNode[] = [];

  interface MutableNode {
    label: string;
    path: string[];
    key: string;
    depth: number;
    columnIndexes: number[];
    children: MutableNode[];
  }

  for (const header of headers) {
    const labels =
      header.path.length > 0 ? header.path : [`Column ${header.letter}`];
    let level: MutableNode[] = roots as unknown as MutableNode[];
    for (let depth = 0; depth < labels.length; depth += 1) {
      const path = labels.slice(0, depth + 1);
      let node = level.find(
        (candidate) =>
          candidate.label === labels[depth] &&
          candidate.path.length === path.length,
      );
      if (!node) {
        node = {
          label: labels[depth],
          path,
          key: path.join(separator),
          depth,
          columnIndexes: [],
          children: [],
        };
        level.push(node);
      }
      if (depth === labels.length - 1 && !node.columnIndexes.includes(header.index)) {
        node.columnIndexes.push(header.index);
      }
      level = node.children;
    }
  }

  return roots as HeaderNode[];
}

export function buildHeaders(
  worksheet: NormalizedWorksheet,
  options: ImportOptions,
): HeaderBuildResult {
  const selection = selectHeaderRows(worksheet, options);
  const dataStartRow = worksheet.dataStartRow ?? selection.dataStartRow;
  const trim = options.trimHeaders !== false;
  const separator = options.keySeparator ?? " / ";
  const columns = visibleColumns(
    worksheet.columnCount,
    worksheet.hiddenColumns,
    options.includeHiddenColumns === true,
  );
  const mergeMap = buildMergeMap(worksheet, selection.rows);
  const usedKeys = new Set<string>();
  const headers: HeaderColumn[] = [];

  for (const column of columns) {
    const result = buildHeaderPath(
      worksheet,
      mergeMap,
      column,
      selection.rows,
      trim,
    );
    const letter = columnToLetter(column);
    const name = result.path.length > 0
      ? result.path[result.path.length - 1]
      : "";
    const base = result.path.length > 0
      ? result.path.join(separator)
      : `Column ${letter}`;
    const keyResult = uniqueKey(base, usedKeys);
    const identity = result.path.length > 0
      ? result.path
      : [`Column ${letter}`];
    headers.push({
      index: headers.length,
      columnIndex: column,
      sourceColumn: column,
      originalColumnIndex: column,
      column: column + 1,
      letter,
      path: result.path,
      fullPath: result.path,
      key: keyResult.key,
      id: JSON.stringify(identity),
      name,
      label: name,
      depth: result.path.length,
      levels: result.levels,
      headerCells: result.headerCells,
      duplicate: keyResult.duplicate,
    });
  }

  return {
    headers,
    headerRows: selection.rows,
    headerRange: selection.range,
    dataStartRow,
    headerDepth: headers.reduce(
      (depth, header) => Math.max(depth, header.path.length),
      0,
    ),
    headerTree: buildHeaderTree(headers, separator),
  };
}
