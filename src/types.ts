/**
 * Public types for the header-association package.
 *
 * The input is an already-rectangularized grid. Spanned positions reference
 * the very same {@link Cell} object, so spans are derived from object
 * identity rather than explicit row/column span fields.
 */

export type CellRole = 'data' | 'header';

export type CellScope = 'row' | 'col' | 'none';

export interface Cell {
  /** Unique identifier of the cell. */
  id: string;
  /** Whether the cell carries a data value or acts as a header. */
  role: CellRole;
  /** Header orientation. Ignored for data cells. */
  scope: CellScope;
  /** Explicit header IDs, ordered as authored. Empty means auto-association. */
  headers: string[];
  /** Original cell text, preserved verbatim in the output. */
  text: string;
}

/** A rectangular grid; each inner array is one row of cell references. */
export type Grid = Cell[][];

/** Inclusive row/column extent occupied by a cell within the grid. */
export interface CellRect {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/** Why the whole-table association failed. */
export type AssociationErrorCode =
  | 'MISSING_HEADER_ID'
  | 'HEADER_REFERS_TO_DATA'
  | 'CYCLIC_HEADER_DEPENDENCY';

/** The resolved header path for one data cell. */
export interface DataHeaderResult {
  /** ID of the data cell (its top-left grid position determines ordering). */
  dataId: string;
  /** Original text of the data cell, untouched. */
  text: string;
  /** Resolved, de-duplicated, leaf header IDs in first-reach order. */
  headerPath: string[];
}

/** A unique cell together with its derived geometry. */
export interface IndexedCell {
  cell: Cell;
  rect: CellRect;
}
