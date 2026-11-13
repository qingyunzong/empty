/**
 * A cell as it is commonly exposed by TypeScript worksheet parsers.
 *
 * Primitives are accepted directly. Object cells may use any of the common
 * field names (for example SheetJS' `v`/`f` or ExcelJS' nested
 * `{ value: { formula, result } }`). Formula cells always resolve to their
 * cached value; the formula expression itself is never used as a cell value.
 */
export type CellInput = unknown;

export type RowInput =
  | readonly CellInput[]
  | {
      readonly cells?: readonly CellInput[] | Record<string, CellInput>;
      readonly values?: readonly CellInput[] | Record<string, CellInput>;
      readonly data?: readonly CellInput[];
      readonly hidden?: boolean;
      readonly row?: number;
      readonly rowIndex?: number;
      readonly [key: string]: unknown;
    }
  | Record<string, CellInput>;

/** Inclusive, zero-based rectangular range. */
export interface NormalizedRange {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

/**
 * A merged range may be supplied as an A1 reference (`"A1:B2"`) or as an
 * object. Object coordinates are zero-based, matching `!merges` in SheetJS and
 * most TypeScript worksheet parsers.
 */
export type RangeInput =
  | string
  | {
      readonly s?: CoordinateInput;
      readonly e?: CoordinateInput;
      readonly start?: CoordinateInput;
      readonly end?: CoordinateInput;
      readonly from?: CoordinateInput;
      readonly to?: CoordinateInput;
      readonly startRow?: number;
      readonly startColumn?: number;
      readonly startCol?: number;
      readonly endRow?: number;
      readonly endColumn?: number;
      readonly endCol?: number;
      readonly top?: number;
      readonly left?: number;
      readonly bottom?: number;
      readonly right?: number;
      readonly minRow?: number;
      readonly minColumn?: number;
      readonly minCol?: number;
      readonly maxRow?: number;
      readonly maxColumn?: number;
      readonly maxCol?: number;
      readonly row?: number;
      readonly column?: number;
      readonly ref?: string;
      readonly range?: string;
      /** Set when an object's coordinates are one-based. */
      readonly oneBased?: boolean;
      /** Treats the object as an Excel/one-based range. */
      readonly excel?: boolean;
      readonly [key: string]: unknown;
    };

export interface CoordinateInput {
  readonly r?: number;
  readonly c?: number;
  readonly row?: number;
  readonly column?: number;
  readonly col?: number;
  readonly rowIndex?: number;
  readonly columnIndex?: number;
  readonly colIndex?: number;
  readonly [key: string]: unknown;
}

export type HiddenInput =
  | readonly (number | boolean | string | HiddenItem)[]
  | ReadonlySet<number | string>
  | Record<string, boolean | HiddenItem>
  | {
      readonly [key: string]: boolean | HiddenItem;
    };

export interface HiddenItem {
  readonly index?: number;
  readonly row?: number;
  readonly rowIndex?: number;
  readonly column?: number;
  readonly columnIndex?: number;
  readonly col?: number;
  readonly colIndex?: number;
  readonly hidden?: boolean;
  readonly [key: string]: unknown;
}

export type FormulaCacheInput =
  | readonly (readonly unknown[])[]
  | ReadonlyMap<string | number, unknown>
  | Record<string, unknown>
  | {
      readonly get?: (key: string | number) => unknown;
      readonly [key: string]: unknown;
    };

/**
 * Minimal worksheet shape accepted by the importer. All aliases are optional;
 * a 2D cell matrix may also be passed directly as the first argument.
 */
export interface WorksheetInput {
  readonly rows?: readonly RowInput[] | Record<string, RowInput>;
  readonly cells?: unknown;
  readonly values?: unknown;
  readonly data?: unknown;
  readonly grid?: unknown;
  readonly matrix?: unknown;
  readonly mergedRanges?: readonly RangeInput[];
  readonly merges?: readonly RangeInput[];
  readonly mergedCells?: readonly RangeInput[];
  readonly mergeRanges?: readonly RangeInput[];
  readonly hiddenRows?: HiddenInput;
  readonly hiddenRowIndexes?: HiddenInput;
  readonly hiddenRowIndices?: HiddenInput;
  readonly hiddenRowsIndexes?: HiddenInput;
  readonly hiddenColumns?: HiddenInput;
  readonly hiddenColumnIndexes?: HiddenInput;
  readonly hiddenColumnIndices?: HiddenInput;
  readonly hiddenCols?: HiddenInput;
  readonly hidden?: {
    readonly rows?: HiddenInput;
    readonly columns?: HiddenInput;
    readonly cols?: HiddenInput;
  };
  readonly formulaCache?: FormulaCacheInput;
  readonly formulaValues?: FormulaCacheInput;
  readonly cachedValues?: FormulaCacheInput;
  readonly cache?: FormulaCacheInput;
  readonly headerStartRow?: number;
  readonly headerRows?: number | readonly number[];
  readonly headerRowCount?: number;
  readonly headerDepth?: number;
  readonly dataStartRow?: number;
  readonly firstDataRow?: number;
  readonly rowCount?: number;
  readonly columnCount?: number;
  readonly width?: number;
  readonly range?: string;
  readonly dimension?: string;
  readonly name?: string;
  readonly sheetName?: string;
  /** SheetJS-style worksheet metadata. */
  readonly "!ref"?: string;
  readonly "!merges"?: readonly RangeInput[];
  readonly "!rows"?: readonly ({ readonly hidden?: boolean } | undefined)[];
  readonly "!cols"?: readonly ({ readonly hidden?: boolean } | undefined)[];
  readonly [key: string]: unknown;
}

export interface ImportOptions {
  /**
   * Number of physical header rows, or explicit zero-based header row
   * indices. Hidden rows inside the range are not emitted as header levels.
   */
  readonly headerRows?: number | readonly number[];
  /** Alias for a numeric `headerRows`. */
  readonly headerRowCount?: number;
  /** Alias for a numeric `headerRows`, expressed as header levels. */
  readonly headerDepth?: number;
  /** Zero-based physical row at which the header starts. */
  readonly headerStartRow?: number;
  /** Zero-based physical row at which data starts. */
  readonly dataStartRow?: number;
  /** Alias for `dataStartRow`. */
  readonly firstDataRow?: number;
  /** Set to false to import every row as data. */
  readonly hasHeader?: boolean;
  /** Include hidden rows in the resulting data. Defaults to false. */
  readonly includeHiddenRows?: boolean;
  /** Include hidden columns in the result. Defaults to false. */
  readonly includeHiddenColumns?: boolean;
  /** Drop completely empty data rows. Defaults to true. */
  readonly skipEmptyRows?: boolean;
  /** Trim header labels. Defaults to true. */
  readonly trimHeaders?: boolean;
  /** Separator used to form `HeaderColumn.key` from its path. Defaults to `" / "`. */
  readonly keySeparator?: string;
  /** Overrides hidden rows supplied by the worksheet. */
  readonly hiddenRows?: HiddenInput;
  /** Overrides hidden columns supplied by the worksheet. */
  readonly hiddenColumns?: HiddenInput;
  /** Overrides the worksheet formula cache. */
  readonly formulaCache?: FormulaCacheInput;
}

export interface HeaderCellReference {
  /** Zero-based physical row. */
  readonly rowIndex: number;
  /** One-based physical row. */
  readonly row: number;
  /** Zero-based physical column. */
  readonly columnIndex: number;
  /** One-based physical column. */
  readonly column: number;
  readonly address: string;
  readonly value: unknown;
  /** Present when the label came from a merged range. */
  readonly merge?: NormalizedRange;
}

export interface HeaderColumn {
  /** Zero-based index among visible columns. */
  readonly index: number;
  /** Zero-based physical column in the worksheet. */
  readonly columnIndex: number;
  /** Alias for `columnIndex`. */
  readonly sourceColumn: number;
  /** Alias for `columnIndex`. */
  readonly originalColumnIndex: number;
  /** One-based physical column. */
  readonly column: number;
  readonly letter: string;
  /** Complete header path, for example `["Sales", "Q1"]`. */
  readonly path: readonly string[];
  /** Alias for `path`. */
  readonly fullPath: readonly string[];
  /** A stable, human-readable key formed from the complete path. */
  readonly key: string;
  /** Machine-stable path identity (JSON encoded). */
  readonly id: string;
  /** Leaf label. Empty when no non-empty header label exists. */
  readonly name: string;
  /** Alias for `name`. */
  readonly label: string;
  readonly depth: number;
  /** One entry per visible header row; `null` means an empty unmerged cell. */
  readonly levels: readonly (string | null)[];
  /** The cells that contributed path segments. */
  readonly headerCells: readonly HeaderCellReference[];
  /** True when another column would otherwise have the same key. */
  readonly duplicate: boolean;
}

export interface ImportedCell {
  readonly key: string;
  readonly path: readonly string[];
  readonly name: string;
  /** Zero-based physical row. */
  readonly rowIndex: number;
  /** One-based physical row. */
  readonly row: number;
  /** Zero-based physical column. */
  readonly columnIndex: number;
  /** Alias for `columnIndex`. */
  readonly sourceColumn: number;
  /** Alias for `columnIndex`. */
  readonly originalColumnIndex: number;
  /** One-based physical column. */
  readonly column: number;
  readonly address: string;
  readonly value: unknown;
}

export interface TableRow {
  /** Zero-based physical worksheet row. */
  readonly rowIndex: number;
  /** Alias for `rowIndex`. */
  readonly sourceRow: number;
  /** Alias for `rowIndex`. */
  readonly originalRowIndex: number;
  /** One-based physical worksheet row. */
  readonly row: number;
  /** Values keyed by the complete header path key. */
  readonly values: Record<string, unknown>;
  /** Alias for `values`. */
  readonly record: Record<string, unknown>;
  /** Cells with their original coordinates preserved. */
  readonly cells: readonly ImportedCell[];
  readonly isEmpty: boolean;
}

export interface HeaderNode {
  readonly label: string;
  readonly path: readonly string[];
  readonly key: string;
  readonly depth: number;
  readonly columnIndexes: readonly number[];
  readonly children: readonly HeaderNode[];
}

export interface TableStructure {
  /** Leaf columns, ordered from left to right. */
  readonly headers: readonly HeaderColumn[];
  /** Alias for `headers`. */
  readonly columns: readonly HeaderColumn[];
  /** Data rows, ordered from top to bottom. */
  readonly rows: readonly TableRow[];
  /** Alias for `rows`. */
  readonly data: readonly TableRow[];
  /** Physical indices of visible header rows that contributed levels. */
  readonly headerRows: readonly number[];
  readonly headerRowIndices: readonly number[];
  /** Physical header extent, including hidden rows. */
  readonly headerRange: NormalizedRange | null;
  /** Zero-based physical row at which data begins. */
  readonly dataStartRow: number;
  readonly hiddenRows: readonly number[];
  readonly hiddenColumns: readonly number[];
  readonly merges: readonly NormalizedRange[];
  readonly rowCount: number;
  readonly columnCount: number;
  readonly headerDepth: number;
  readonly headerTree: readonly HeaderNode[];
}
