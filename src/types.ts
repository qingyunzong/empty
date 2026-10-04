export interface Row {
  id: string;
  key: string;
  value: number;
  attrs?: Record<string, string | number | boolean>;
}

export type RowFilter = (row: Row) => boolean;

export interface QuerySpec {
  filter: RowFilter;
  k: number;
}

export interface ResultEntry {
  key: string;
  sum: number;
}

export interface Change {
  key: string;
  oldSum: number | null;
  newSum: number | null;
}

export interface Delta {
  version: number;
  generation: number;
  changes: Change[];
}

export type BatchOp =
  | { type: "upsert"; row: Row }
  | { type: "delete"; id: string };
