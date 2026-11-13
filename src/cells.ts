import type {
  FormulaCacheInput,
  HiddenInput,
  NormalizedRange,
  RangeInput,
} from "./types.ts";

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

export function columnToLetter(column: number): string {
  if (!Number.isInteger(column) || column < 0) {
    throw new RangeError(`Invalid column index: ${column}`);
  }

  let value = column + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export function letterToColumn(letters: string): number {
  const normalized = letters.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new RangeError(`Invalid column reference: ${letters}`);
  }

  let column = 0;
  for (const character of normalized) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return column - 1;
}

export function cellAddress(row: number, column: number): string {
  return `${columnToLetter(column)}${row + 1}`;
}

function normalizeCoordinate(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readPair(
  start: Record<string, unknown> | undefined,
  end: Record<string, unknown> | undefined,
  oneBased: boolean,
): NormalizedRange | null {
  if (!start || !end) {
    return null;
  }

  const startRow = normalizeCoordinate(
    start.r ?? start.row ?? start.rowIndex,
    Number.NaN,
  );
  const startColumn = normalizeCoordinate(
    start.c ?? start.column ?? start.col ?? start.columnIndex ?? start.colIndex,
    Number.NaN,
  );
  const endRow = normalizeCoordinate(
    end.r ?? end.row ?? end.rowIndex,
    Number.NaN,
  );
  const endColumn = normalizeCoordinate(
    end.c ?? end.column ?? end.col ?? end.columnIndex ?? end.colIndex,
    Number.NaN,
  );

  if (
    !Number.isFinite(startRow) ||
    !Number.isFinite(startColumn) ||
    !Number.isFinite(endRow) ||
    !Number.isFinite(endColumn)
  ) {
    return null;
  }

  const shift = oneBased ? 1 : 0;
  return {
    startRow: Math.min(startRow, endRow) - shift,
    startColumn: Math.min(startColumn, endColumn) - shift,
    endRow: Math.max(startRow, endRow) - shift,
    endColumn: Math.max(startColumn, endColumn) - shift,
  };
}

/**
 * Parses an A1-style range. A1 references are one-based, as they are in Excel.
 * The returned range is inclusive and zero-based.
 */
export function rangeFromA1(reference: string): NormalizedRange {
  let text = reference.trim();
  if (!text) {
    throw new RangeError("Merged range cannot be empty");
  }

  const sheetSeparator = text.lastIndexOf("!");
  if (sheetSeparator >= 0) {
    text = text.slice(sheetSeparator + 1).trim();
  }

  const match =
    /^\$?([A-Za-z]{1,4})\$?(\d+)(?:\s*:\s*\$?([A-Za-z]{1,4})\$?(\d+))?$/.exec(
      text,
    );
  if (!match) {
    throw new RangeError(`Invalid A1 range: ${reference}`);
  }

  const startColumn = letterToColumn(match[1]);
  const startRow = Number.parseInt(match[2], 10) - 1;
  const endColumn =
    match[3] === undefined ? startColumn : letterToColumn(match[3]);
  const endRow =
    match[4] === undefined
      ? startRow
      : Number.parseInt(match[4], 10) - 1;

  return {
    startRow: Math.min(startRow, endRow),
    startColumn: Math.min(startColumn, endColumn),
    endRow: Math.max(startRow, endRow),
    endColumn: Math.max(startColumn, endColumn),
  };
}

function coordinateFromValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Normalizes a range object or A1 string to an inclusive zero-based range. */
export function normalizeRange(input: RangeInput): NormalizedRange {
  if (typeof input === "string") {
    return rangeFromA1(input);
  }
  if (!isRecord(input)) {
    throw new TypeError(`Invalid merged range: ${String(input)}`);
  }

  if (typeof input.ref === "string") {
    return rangeFromA1(input.ref);
  }
  if (typeof input.range === "string") {
    return rangeFromA1(input.range);
  }

  const oneBased = input.oneBased === true || input.excel === true;
  const pairStart =
    coordinateFromValue(input.s) ??
    coordinateFromValue(input.start) ??
    coordinateFromValue(input.from);
  const pairEnd =
    coordinateFromValue(input.e) ??
    coordinateFromValue(input.end) ??
    coordinateFromValue(input.to);
  const pair = readPair(pairStart ?? undefined, pairEnd ?? undefined, oneBased);
  if (pair) {
    return pair;
  }

  const startRow = normalizeCoordinate(
    input.startRow ??
      input.startRowIndex ??
      input.r1 ??
      input.row1 ??
      input.top ??
      input.minRow,
    Number.NaN,
  );
  const startColumn = normalizeCoordinate(
      input.startColumn ??
      input.startCol ??
      input.startColumnIndex ??
      input.c1 ??
      input.col1 ??
      input.left ??
      input.minColumn ??
      input.minCol,
    Number.NaN,
  );
  const endRow = normalizeCoordinate(
    input.endRow ??
      input.endRowIndex ??
      input.r2 ??
      input.row2 ??
      input.bottom ??
      input.maxRow,
    Number.NaN,
  );
  const endColumn = normalizeCoordinate(
      input.endColumn ??
      input.endCol ??
      input.endColumnIndex ??
      input.c2 ??
      input.col2 ??
      input.right ??
      input.maxColumn ??
      input.maxCol,
    Number.NaN,
  );

  if (
    Number.isFinite(startRow) &&
    Number.isFinite(startColumn) &&
    Number.isFinite(endRow) &&
    Number.isFinite(endColumn)
  ) {
    const shift = oneBased ? 1 : 0;
    return {
      startRow: Math.min(startRow, endRow) - shift,
      startColumn: Math.min(startColumn, endColumn) - shift,
      endRow: Math.max(startRow, endRow) - shift,
      endColumn: Math.max(startColumn, endColumn) - shift,
    };
  }

  const rowSpan = normalizeCoordinate(
    input.rowSpan ?? input.rowspan,
    Number.NaN,
  );
  const columnSpan = normalizeCoordinate(
    input.columnSpan ?? input.columnspan ?? input.colSpan ?? input.colspan,
    Number.NaN,
  );
  const spanStartRow = Number.isFinite(startRow)
    ? startRow
    : normalizeCoordinate(input.row ?? input.rowIndex ?? input.r, Number.NaN);
  const spanStartColumn = Number.isFinite(startColumn)
    ? startColumn
    : normalizeCoordinate(
        input.column ??
          input.col ??
          input.columnIndex ??
          input.colIndex ??
          input.c,
        Number.NaN,
      );
  if (
    Number.isFinite(spanStartRow) &&
    Number.isFinite(spanStartColumn) &&
    Number.isFinite(rowSpan) &&
    Number.isFinite(columnSpan) &&
    rowSpan > 0 &&
    columnSpan > 0
  ) {
    const shift = oneBased ? 1 : 0;
    return {
      startRow: spanStartRow - shift,
      startColumn: spanStartColumn - shift,
      endRow: spanStartRow + rowSpan - 1 - shift,
      endColumn: spanStartColumn + columnSpan - 1 - shift,
    };
  }

  const singleRow = normalizeCoordinate(
    input.row ?? input.rowIndex ?? input.r,
    Number.NaN,
  );
  const singleColumn = normalizeCoordinate(
    input.column ??
      input.col ??
      input.columnIndex ??
      input.colIndex ??
      input.c,
    Number.NaN,
  );
  if (Number.isFinite(singleRow) && Number.isFinite(singleColumn)) {
    const shift = oneBased ? 1 : 0;
    return {
      startRow: singleRow - shift,
      startColumn: singleColumn - shift,
      endRow: singleRow - shift,
      endColumn: singleColumn - shift,
    };
  }

  throw new RangeError(
    `Invalid merged range object: ${JSON.stringify(input)}`,
  );
}

export function validRange(range: NormalizedRange, source: unknown): void {
  const values = [
    range.startRow,
    range.startColumn,
    range.endRow,
    range.endColumn,
  ];
  if (
    values.some(
      (value) => !Number.isInteger(value) || value < 0,
    ) ||
    range.endRow < range.startRow ||
    range.endColumn < range.startColumn
  ) {
    throw new RangeError(
      `Invalid merged range: ${JSON.stringify(source)}`,
    );
  }
}

export function rangesOverlap(
  left: NormalizedRange,
  right: NormalizedRange,
): boolean {
  return (
    left.startRow <= right.endRow &&
    right.startRow <= left.endRow &&
    left.startColumn <= right.endColumn &&
    right.startColumn <= left.endColumn
  );
}

export function rangeAddress(range: NormalizedRange): string {
  const start = cellAddress(range.startRow, range.startColumn);
  const end = cellAddress(range.endRow, range.endColumn);
  return start === end ? start : `${start}:${end}`;
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function firstPresent(
  value: Record<string, unknown>,
  keys: readonly string[],
): { found: boolean; value: unknown } {
  for (const key of keys) {
    if (own(value, key)) {
      return { found: true, value: value[key] };
    }
  }
  return { found: false, value: undefined };
}

function unwrapCachedValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if (Array.isArray(value.richText)) {
    return value.richText
      .map((run) =>
        isRecord(run) && typeof run.text === "string" ? run.text : "",
      )
      .join("");
  }

  const nested = firstPresent(value, [
    "cachedValue",
    "cached",
    "result",
    "value",
    "v",
    "text",
    "w",
  ]);
  return nested.found ? nested.value : value;
}

function hasFormula(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (
    own(value, "formula") ||
    own(value, "f") ||
    own(value, "sharedFormula") ||
    own(value, "arrayFormula")
  ) {
    return true;
  }
  return isRecord(value.value) && hasFormula(value.value);
}

function formulaText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["formula", "f", "sharedFormula", "arrayFormula"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return isRecord(value.value) ? formulaText(value.value) : undefined;
}

function lookupCacheEntry(cache: FormulaCacheInput, key: string): unknown {
  if (Array.isArray(cache)) {
    return undefined;
  }

  const maybeMap = cache as { get?: unknown };
  if (typeof maybeMap.get === "function") {
    const get = maybeMap.get as (key: string) => unknown;
    const result = get.call(cache, key);
    if (result !== undefined) {
      return result;
    }
  }

  if (isRecord(cache) && own(cache, key)) {
    return cache[key];
  }
  return undefined;
}

export function lookupFormulaCache(
  cache: FormulaCacheInput | undefined,
  row: number,
  column: number,
  formula?: string,
): { found: boolean; value: unknown } {
  if (!cache) {
    return { found: false, value: undefined };
  }

  if (Array.isArray(cache)) {
    const rowValues = cache[row];
    if (Array.isArray(rowValues) && column < rowValues.length) {
      return { found: true, value: unwrapCachedValue(rowValues[column]) };
    }
    return { found: false, value: undefined };
  }

  const keys = [
    cellAddress(row, column),
    `${row},${column}`,
    `${row}:${column}`,
    `R${row + 1}C${column + 1}`,
  ];
  for (const key of keys) {
    const value = lookupCacheEntry(cache, key);
    if (value !== undefined) {
      return { found: true, value: unwrapCachedValue(value) };
    }
  }

  if (formula) {
    const candidates = formula.startsWith("=")
      ? [formula, formula.slice(1)]
      : [formula, `=${formula}`];
    for (const key of candidates) {
      const value = lookupCacheEntry(cache, key);
      if (value !== undefined) {
        return { found: true, value: unwrapCachedValue(value) };
      }
    }
  }

  if (isRecord(cache)) {
    const rowEntry = cache[String(row)];
    if (Array.isArray(rowEntry) && column < rowEntry.length) {
      return { found: true, value: unwrapCachedValue(rowEntry[column]) };
    }
    if (isRecord(rowEntry) && own(rowEntry, String(column))) {
      return {
        found: true,
        value: unwrapCachedValue(rowEntry[String(column)]),
      };
    }
  }

  return { found: false, value: undefined };
}

/**
 * Resolves a cell to its display/value form. Formula cells use, in order, an
 * inline cached result, the sheet-level formula cache, or `undefined`.
 */
export function resolveCellValue(
  cell: unknown,
  row: number,
  column: number,
  cache: FormulaCacheInput | undefined,
): unknown {
  if (!isRecord(cell)) {
    return cell;
  }

  const formula = hasFormula(cell);
  const direct = firstPresent(cell, [
    "cachedValue",
    "cached",
    "result",
    "v",
    "value",
    "text",
    "w",
  ]);

  let value = direct.found ? unwrapCachedValue(direct.value) : undefined;
  if (formula && (value === undefined || isRecord(direct.value))) {
    const cached = lookupFormulaCache(
      cache,
      row,
      column,
      formulaText(cell),
    );
    if (cached.found) {
      value = cached.value;
    } else if (value === undefined) {
      value = undefined;
    }
  }

  if (!direct.found && !formula && Array.isArray(cell.richText)) {
    value = unwrapCachedValue(cell);
  }

  return value;
}

function numericIndex(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value, 10);
}

function addHiddenIndex(target: Set<number>, value: unknown, kind: "row" | "column"): void {
  if (typeof value === "boolean") {
    return;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    target.add(value);
    return;
  }
  if (typeof value === "string") {
    const number = numericIndex(value);
    if (number !== null) {
      target.add(number);
      return;
    }
    if (kind === "column" && /^[A-Za-z]{1,4}$/.test(value.trim())) {
      target.add(letterToColumn(value));
      return;
    }
  }
}

function hiddenItemIndex(
  item: Record<string, unknown>,
  kind: "row" | "column",
): number | null {
  const candidate =
    kind === "row"
      ? item.rowIndex ?? item.row ?? item.index
      : item.columnIndex ??
        item.column ??
        item.colIndex ??
        item.col ??
        item.index;
  if (typeof candidate === "number" && Number.isInteger(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string") {
    const number = numericIndex(candidate);
    if (number !== null) {
      return number;
    }
    if (kind === "column" && /^[A-Za-z]{1,4}$/.test(candidate.trim())) {
      return letterToColumn(candidate);
    }
  }
  return null;
}

/** Converts the many common hidden-row/column representations to a Set. */
export function normalizeHidden(
  input: HiddenInput | undefined,
  kind: "row" | "column",
): Set<number> {
  const result = new Set<number>();
  if (input === undefined || input === null) {
    return result;
  }

  if (input instanceof Set) {
    for (const value of input) {
      addHiddenIndex(result, value, kind);
    }
    return result;
  }

  if (Array.isArray(input)) {
    input.forEach((value, index) => {
      if (typeof value === "boolean") {
        if (value) {
          result.add(index);
        }
      } else if (isRecord(value)) {
        if (value.hidden === false) {
          return;
        }
        const entryIndex = hiddenItemIndex(value, kind);
        if (entryIndex !== null) {
          result.add(entryIndex);
        } else if (value.hidden === true) {
          result.add(index);
        }
      } else if (typeof value === "string") {
        addHiddenIndex(result, value, kind);
      } else {
        addHiddenIndex(result, value, kind);
      }
    });
    return result;
  }

  if (isRecord(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (value === false || value === null || value === undefined) {
        continue;
      }
      if (isRecord(value) && value.hidden === false) {
        continue;
      }
      const entryIndex =
        typeof value === "boolean"
          ? (() => {
              const parsed = numericIndex(key);
              if (parsed !== null) {
                return parsed;
              }
              if (kind === "column" && /^[A-Za-z]{1,4}$/.test(key)) {
                return letterToColumn(key);
              }
              return null;
            })()
          : (() => {
              const parsed = numericIndex(key);
              if (parsed !== null) {
                return parsed;
              }
              if (kind === "column" && /^[A-Za-z]{1,4}$/.test(key)) {
                return letterToColumn(key);
              }
              return hiddenItemIndex(value as Record<string, unknown>, kind);
            })();
      if (entryIndex !== null) {
        result.add(entryIndex);
      }
    }
  }

  return result;
}

export function headerLabel(value: unknown, trim: boolean): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return trim ? value.trim() : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return trim ? value.text.trim() : value.text;
    }
    if (typeof value.value === "string") {
      return trim ? value.value.trim() : value.value;
    }
  }
  return String(value);
}
