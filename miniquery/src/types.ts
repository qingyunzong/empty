/** Query AST and value model shared by the engine and the reference interpreter. */

/** Runtime cell value. JSON integers are kept as bigint for exactness. */
export type Value = null | boolean | string | number | bigint;

/** A row keyed by qualified column name "alias.column". */
export type Row = Map<string, Value>;

export type TableInput = {
  rows: Record<string, unknown>[];
  /** Optional declared schema (needed to reference columns of an empty table). */
  columns?: string[];
};

export type Expr =
  | { col: string }
  | { lit: unknown }
  | { op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; args: [Expr, Expr] }
  | { op: "and" | "or"; args: Expr[] }
  | { op: "not"; arg: Expr }
  | { op: "isNull" | "isNotNull"; arg: Expr };

export type AggFn = "count" | "sum" | "min" | "max" | "avg";

export type AggSpec = { fn: AggFn; arg: "*" | string };

export type SelectItem =
  | { col: string; as?: string }
  | { agg: AggSpec; as?: string };

export type Source = { table: string; as?: string };

export type Join = Source & { on: Expr };

export type Query = {
  from: Source;
  joins?: Join[];
  where?: Expr;
  groupBy?: string[];
  select: SelectItem[];
};

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}
