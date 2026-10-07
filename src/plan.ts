import { Expr, Row, evalPred, showExpr } from "./expr.js";
import { Table } from "./table.js";

export type JoinKind = "inner" | "left" | "right" | "full";

/**
 * Logical query plan. Assumption (documented, checked by `execute`):
 * column names are globally unique across all scans in one plan, so merged
 * join rows never collide.
 */
export type Plan =
  | { op: "scan"; table: Table }
  | { op: "filter"; pred: Expr; input: Plan }
  | { op: "project"; cols: string[]; input: Plan }
  | { op: "join"; kind: JoinKind; pred: Expr; left: Plan; right: Plan };

export const scan = (table: Table): Plan => ({ op: "scan", table });
export const filter = (pred: Expr, input: Plan): Plan => ({ op: "filter", pred, input });
export const project = (cols: string[], input: Plan): Plan => ({ op: "project", cols, input });
export const join = (kind: JoinKind, pred: Expr, left: Plan, right: Plan): Plan =>
  ({ op: "join", kind, pred, left, right });

export interface Result {
  schema: string[];
  rows: Row[];
}

export function schemaOf(p: Plan): string[] {
  switch (p.op) {
    case "scan": return [...p.table.schema];
    case "filter": return schemaOf(p.input);
    case "project": return [...p.cols];
    case "join": return [...schemaOf(p.left), ...schemaOf(p.right)];
  }
}

export function execute(p: Plan): Result {
  switch (p.op) {
    case "scan":
      return { schema: [...p.table.schema], rows: p.table.rows.map((r) => ({ ...r })) };
    case "filter": {
      const inner = execute(p.input);
      // SQL WHERE keeps only rows where the predicate is TRUE (not FALSE, not UNKNOWN).
      return { schema: inner.schema, rows: inner.rows.filter((r) => evalPred(p.pred, r) === "true") };
    }
    case "project": {
      const inner = execute(p.input);
      return {
        schema: [...p.cols],
        rows: inner.rows.map((r) => {
          const out: Row = {};
          for (const c of p.cols) out[c] = r[c] ?? null;
          return out;
        }),
      };
    }
    case "join": {
      const L = execute(p.left);
      const R = execute(p.right);
      const rNulls: Row = {};
      for (const c of R.schema) rNulls[c] = null;
      const lNulls: Row = {};
      for (const c of L.schema) lNulls[c] = null;
      const rows: Row[] = [];
      const matchedRight = new Array<boolean>(R.rows.length).fill(false);
      for (const l of L.rows) {
        let matched = false;
        for (let j = 0; j < R.rows.length; j++) {
          const r = R.rows[j]!;
          const merged = { ...l, ...r };
          if (evalPred(p.pred, merged) === "true") {
            matched = true;
            matchedRight[j] = true;
            rows.push(merged);
          }
        }
        if (!matched && (p.kind === "left" || p.kind === "full")) {
          rows.push({ ...l, ...rNulls });
        }
      }
      if (p.kind === "right" || p.kind === "full") {
        for (let j = 0; j < R.rows.length; j++) {
          if (!matchedRight[j]) rows.push({ ...lNulls, ...R.rows[j]! });
        }
      }
      return { schema: [...L.schema, ...R.schema], rows };
    }
  }
}

/** Stable textual fingerprint of a plan, used in rewrite certificates. */
export function showPlan(p: Plan, indent = 0): string {
  const pad = "  ".repeat(indent);
  switch (p.op) {
    case "scan": return `${pad}Scan(${p.table.schema.join(",")})`;
    case "filter": return `${pad}Filter(${showExpr(p.pred)})\n${showPlan(p.input, indent + 1)}`;
    case "project": return `${pad}Project(${p.cols.join(",")})\n${showPlan(p.input, indent + 1)}`;
    case "join":
      return `${pad}Join[${p.kind}](${showExpr(p.pred)})\n${showPlan(p.left, indent + 1)}\n${showPlan(p.right, indent + 1)}`;
  }
}
